const path = require('path');
const AdmZip = require('adm-zip');
const { parseString } = require('xml2js');
const { createLogger } = require('./logger');

// Maximum total decompressed bytes we will pull out of a .cbz archive.
// .cbz files are XML payloads zipped together; typical real files are well
// under 5MB extracted. Cap defends against zip-bomb uploads that could
// otherwise exhaust process memory before xml2js parsing fails.
const MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024; // 100MB

// Defence-in-depth: reject ZIP entry names containing path-traversal or
// absolute paths. The parser does not write extracted files to disk, but
// guarding here means a future change can't accidentally introduce one.
// Pure-function form so it's directly unit-testable; AdmZip sanitises bad
// names on write, so we can't reach this path from a JS-built archive.
function _isSafeZipEntryName(name) {
    if (typeof name !== 'string' || name.length === 0) return false;
    // ZIP entry names use forward slashes regardless of platform, and a
    // malicious archive can embed any separator or drive letter. `path.isAbsolute`
    // is host-OS specific (e.g. on POSIX it misses `C:\...` and `\\server\...`),
    // so test both conventions and reject any drive-letter prefix explicitly.
    if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) return false;
    if (/^[A-Za-z]:/.test(name)) return false;
    const parts = name.split(/[/\\]/);
    return !parts.includes('..');
}

class CbusProjectParser {
    constructor(options = {}) {
        this.logger = createLogger({ component: 'CbusProjectParser' });
        this.maxDecompressedBytes = options.maxDecompressedBytes || MAX_DECOMPRESSED_BYTES;
    }

    /**
     * Parse a CBZ or XML buffer, auto-detecting the format.
     * @param {Buffer} inputBuffer - File contents
     * @param {string} [filename=''] - Original filename (used for format hint and metadata)
     * @param {Object} [options] - Parsing options
     * @param {string|number} [options.network] - Filter to a specific network address
     * @returns {Promise<{labels: Object, networks: Array, stats: Object, source: string}>}
     */
    async parse(inputBuffer, filename = '', options = {}) {
        let xmlString;

        if (this._isCBZ(inputBuffer)) {
            xmlString = this._extractCBZ(inputBuffer);
        } else {
            xmlString = inputBuffer.toString('utf8');
        }

        const parsed = await this._parseXML(xmlString);
        const result = this._extractLabels(parsed, options);
        result.source = filename;
        return result;
    }

    /**
     * Parse a raw XML string directly.
     * @param {string} xmlString
     * @param {Object} [options]
     * @returns {Promise<{labels: Object, networks: Array, stats: Object, source: string}>}
     */
    async parseXML(xmlString, options = {}) {
        const parsed = await this._parseXML(xmlString);
        const result = this._extractLabels(parsed, options);
        result.source = 'xml';
        return result;
    }

    _isCBZ(buffer) {
        // ZIP files start with PK\x03\x04
        return buffer.length >= 4 &&
            buffer[0] === 0x50 && buffer[1] === 0x4B &&
            buffer[2] === 0x03 && buffer[3] === 0x04;
    }

    _extractCBZ(buffer) {
        const zip = new AdmZip(buffer);
        const entries = zip.getEntries();

        // Pre-flight against zip-bomb uploads: sum every entry's declared
        // uncompressed size before we decompress anything. ZIP headers
        // include the uncompressed size so this check costs nothing.
        let totalUncompressed = 0;
        for (const entry of entries) {
            const size = entry.header && entry.header.size;
            if (typeof size === 'number' && size > 0) {
                totalUncompressed += size;
                if (totalUncompressed > this.maxDecompressedBytes) {
                    throw new Error(
                        `CBZ archive decompressed size exceeds ${this.maxDecompressedBytes} bytes; rejecting (zip-bomb protection)`
                    );
                }
            }
        }

        // Find the project XML. Match the extension case-insensitively — C-Bus
        // Toolkit on Windows (e.g. 1.17.6 on Server 2025) can emit ".XML" — and,
        // if that fails, sniff entry contents so we still recognise the project
        // file when a Toolkit version names it without a .xml extension.
        const fileEntries = entries.filter(e => !e.isDirectory);
        let xmlEntry = fileEntries.find(e => e.entryName.toLowerCase().endsWith('.xml'));
        if (!xmlEntry) {
            xmlEntry = fileEntries.find(e => {
                try {
                    const head = e.getData().slice(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart();
                    return head.startsWith('<?xml') || /<(Installation|Network|Project)\b/i.test(head);
                } catch {
                    return false;
                }
            });
        }
        if (!xmlEntry) {
            throw new Error('CBZ archive does not contain an XML file');
        }

        if (!_isSafeZipEntryName(xmlEntry.entryName)) {
            throw new Error(`CBZ archive entry name rejected: ${xmlEntry.entryName}`);
        }

        this.logger.info(`Extracting ${xmlEntry.entryName} from CBZ`);
        return xmlEntry.getData().toString('utf8');
    }

    _parseXML(xmlString) {
        return new Promise((resolve, reject) => {
            parseString(xmlString, { explicitArray: false, ignoreAttrs: false, mergeAttrs: true }, (err, result) => {
                if (err) reject(new Error(`XML parse error: ${err.message}`));
                else resolve(result);
            });
        });
    }

    /**
     * Walk the parsed XML tree and extract network/app/group labels.
     * Handles both CBZ Toolkit format (Installation > Project > Network > Application > Group)
     * and simpler C-Gate tag XML variants.
     */
    _extractLabels(parsed, options = {}) {
        const labels = {};
        const networks = [];
        let groupCount = 0;
        let labelCount = 0;
        const networkFilter = (options.network !== null && options.network !== undefined) ? String(options.network) : null;

        const networkNodes = this._findNetworks(parsed);

        for (const net of networkNodes) {
            const netAddr = this._getAddress(net);
            if (!netAddr) continue;
            if (networkFilter && netAddr !== networkFilter) continue;

            const netName = this._getTagName(net);
            networks.push({ address: netAddr, name: netName });

            const applications = this._findApplications(net);
            for (const app of applications) {
                const appAddr = this._getAddress(app);
                if (!appAddr) continue;

                const groups = this._findGroups(app);
                for (const group of groups) {
                    const groupAddr = this._getAddress(group);
                    if (!groupAddr) continue;
                    groupCount++;

                    const tagName = this._getTagName(group);
                    if (tagName) {
                        const key = `${netAddr}/${appAddr}/${groupAddr}`;
                        labels[key] = tagName;
                        labelCount++;
                    }
                }
            }
        }

        return {
            labels,
            networks,
            stats: { groupCount, labelCount, networkCount: networks.length },
            source: ''
        };
    }

    /**
     * Locate Network nodes from various XML structures.
     * CBZ format: Installation > Project > Network(s)
     * C-Gate tag format: may be Network at root or wrapped differently
     */
    _findNetworks(parsed) {
        if (!parsed || typeof parsed !== 'object') return [];

        // CBZ format: Installation > Project > Network
        const installation = parsed.Installation || parsed.installation;
        if (installation) {
            const project = installation.Project || installation.project;
            if (project) {
                return this._toArray(project.Network || project.network);
            }
        }

        // Direct Project wrapper
        const project = parsed.Project || parsed.project;
        if (project) {
            return this._toArray(project.Network || project.network);
        }

        // Direct Network at root
        if (parsed.Network || parsed.network) {
            return this._toArray(parsed.Network || parsed.network);
        }

        // Walk one level for unknown wrapper elements
        for (const key of Object.keys(parsed)) {
            const child = parsed[key];
            if (child && typeof child === 'object') {
                if (child.Network || child.network) {
                    return this._toArray(child.Network || child.network);
                }
                if (child.Project || child.project) {
                    const p = child.Project || child.project;
                    return this._toArray(p.Network || p.network);
                }
            }
        }

        return [];
    }

    _findApplications(networkNode) {
        return this._toArray(networkNode.Application || networkNode.application);
    }

    _findGroups(appNode) {
        return this._toArray(appNode.Group || appNode.group);
    }

    /**
     * Extract the address from a node. CBZ XML uses attributes (Address, address, NetworkNumber)
     * while C-Gate tag XML may use elements or attributes.
     */
    _getAddress(node) {
        // xml2js with mergeAttrs puts attributes directly on the node
        const candidates = [
            node.Address, node.address,
            node.NetworkNumber, node.network_number, node.networkNumber,
            node.ApplicationAddress, node.GroupAddress
        ];
        for (const val of candidates) {
            if (val !== null && val !== undefined) return String(val);
        }
        return null;
    }

    _getTagName(node) {
        const candidates = [
            node.TagName, node.tag_name, node.tagName, node.TagName,
            node.Label, node.label,
            node.Description, node.description
        ];
        for (const val of candidates) {
            if (val !== null && val !== undefined && typeof val === 'string' && val.trim()) return val.trim();
        }
        return null;
    }

    _toArray(val) {
        if (!val) return [];
        return Array.isArray(val) ? val : [val];
    }
}

module.exports = CbusProjectParser;
module.exports._isSafeZipEntryName = _isSafeZipEntryName;

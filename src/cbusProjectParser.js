const AdmZip = require('adm-zip');
const { parseString } = require('xml2js');
const { createLogger } = require('./logger');

class CbusProjectParser {
    constructor() {
        this.logger = createLogger({ component: 'CbusProjectParser' });
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

        const xmlEntry = entries.find(e => e.entryName.endsWith('.xml'));
        if (!xmlEntry) {
            throw new Error('CBZ archive does not contain an XML file');
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

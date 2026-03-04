const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { LineProcessor } = require('../../src/lineProcessor');
const EventPublisher = require('../../src/eventPublisher');
const CommandResponseProcessor = require('../../src/commandResponseProcessor');
const CBusEvent = require('../../src/cbusEvent');

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
}

function summarize(values) {
    if (!values.length) {
        return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
    }

    const sum = values.reduce((acc, v) => acc + v, 0);
    return {
        count: values.length,
        min: Math.min(...values),
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        p99: percentile(values, 99),
        max: Math.max(...values),
        avg: sum / values.length
    };
}

function roundMetrics(metrics) {
    return Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, Number(v.toFixed(3))]));
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
}

function createNoopLogger(logLevel) {
    return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        isLevelEnabled: (level) => level === 'debug' ? logLevel === 'debug' : false
    };
}

function getEnvNumber(name, fallback) {
    return Number(process.env[name] || fallback);
}

function loadBenchmarkConfig() {
    const variant = process.env.PERF_VARIANT || process.env.PERF_PROFILE || 'baseline';
    return {
        variant,
        dedupWindowMs: Number(process.env.PERF_DEDUP_WINDOW_MS || (variant === 'after' ? 200 : 0)),
        logLevel: process.env.PERF_LOG_LEVEL || 'info',
        repeat: Math.max(1, getEnvNumber('PERF_REPEAT', 5)),
        warmup: Math.max(0, getEnvNumber('PERF_WARMUP', 1)),
        eventCount: getEnvNumber('PERF_EVENT_COUNT', 1500),
        commandCount: getEnvNumber('PERF_COMMAND_COUNT', 1000),
        uniqueGroups: Math.max(1, getEnvNumber('PERF_UNIQUE_GROUPS', 50))
    };
}

function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function pickRepresentativeTrial(trials, pathName) {
    if (!trials.length) return null;
    const sorted = [...trials].sort((a, b) =>
        a[pathName].lineToPublishFlushMs.p95 - b[pathName].lineToPublishFlushMs.p95
    );
    return sorted[Math.floor(sorted.length / 2)];
}

function summarizeTrials(trials) {
    return {
        runCount: trials.length,
        eventThroughputMedian: Number(median(trials.map(t => t.eventPath.throughputMsgsPerSec)).toFixed(2)),
        commandThroughputMedian: Number(median(trials.map(t => t.commandPath.throughputMsgsPerSec)).toFixed(2)),
        eventP95FlushMedianMs: Number(median(trials.map(t => t.eventPath.lineToPublishFlushMs.p95)).toFixed(3)),
        commandP95FlushMedianMs: Number(median(trials.map(t => t.commandPath.lineToPublishFlushMs.p95)).toFixed(3))
    };
}

async function runEventPathBenchmark(profile, config) {
    const eventCount = config.eventCount;
    const uniqueGroups = config.uniqueGroups;
    const publishFlushLatencies = [];
    const lineToParseLatencies = [];
    const lineToPublishCallLatencies = [];
    const lineToPublishFlushLatencies = [];
    const pendingFlushes = [];

    const settings = {
        logging: true,
        log_level: profile.logLevel,
        ha_discovery_pir_app_id: '202',
        ha_discovery_cover_app_id: '203',
        eventPublishDedupWindowMs: profile.eventPublishDedupWindowMs
    };

    const logger = createNoopLogger(profile.logLevel);

    let currentContext = null;
    const publishFn = () => {
        if (!currentContext) return;
        const context = currentContext;
        const publishCallAt = performance.now();
        lineToPublishCallLatencies.push(publishCallAt - context.lineReceivedAt);
        pendingFlushes.push(new Promise((resolve) => {
            setImmediate(() => {
                const flushAt = performance.now();
                const flushLatency = flushAt - context.lineReceivedAt;
                publishFlushLatencies.push(flushAt - publishCallAt);
                lineToPublishFlushLatencies.push(flushLatency);
                resolve();
            });
        }));
    };

    const publisher = new EventPublisher({
        settings,
        publishFn,
        mqttOptions: { qos: 0, retain: false },
        logger
    });

    const lineProcessor = new LineProcessor();
    const startedAt = performance.now();
    let parsedEvents = 0;
    for (let i = 1; i <= eventCount; i++) {
        // Use repeated groups to exercise dedup behavior when enabled.
        const group = (i % uniqueGroups) + 1;
        const line = `lighting on 254/56/${group}\n`;
        lineProcessor.processData(line, (eventLine) => {
            const lineReceivedAt = performance.now();
            const event = new CBusEvent(eventLine);
            const parseDoneAt = performance.now();
            lineToParseLatencies.push(parseDoneAt - lineReceivedAt);
            if (!event.isValid()) {
                return;
            }
            parsedEvents += 1;
            currentContext = { lineReceivedAt };
            publisher.publishEvent(event, '(Perf)');
            currentContext = null;
        });
    }

    await Promise.all(pendingFlushes);
    const elapsedMs = performance.now() - startedAt;
    const throughput = (eventCount / elapsedMs) * 1000;
    lineProcessor.close();

    return {
        profile: profile.name,
        sampleCount: eventCount,
        uniqueGroups,
        parsedEvents,
        throughputMsgsPerSec: Number(throughput.toFixed(2)),
        lineToParseMs: roundMetrics(summarize(lineToParseLatencies)),
        lineToPublishCallMs: roundMetrics(summarize(lineToPublishCallLatencies)),
        lineToPublishFlushMs: roundMetrics(summarize(lineToPublishFlushLatencies)),
        publishCallToFlushMs: roundMetrics(summarize(publishFlushLatencies)),
        publishStats: publisher.getStats()
    };
}

async function runCommandPathBenchmark(profile, config) {
    const commandCount = config.commandCount;
    const lineToPublishCallLatencies = [];
    const lineToPublishFlushLatencies = [];
    const pendingFlushes = [];

    const logger = createNoopLogger(profile.logLevel);

    let currentStart = 0;
    const eventPublisher = {
        publishEvent: () => {
            const publishCalledAt = performance.now();
            lineToPublishCallLatencies.push(publishCalledAt - currentStart);
            pendingFlushes.push(new Promise((resolve) => {
                setImmediate(() => {
                    lineToPublishFlushLatencies.push(performance.now() - currentStart);
                    resolve();
                });
            }));
        }
    };

    const commandProcessor = new CommandResponseProcessor({
        eventPublisher,
        haDiscovery: null,
        onObjectStatus: () => {},
        logger
    });

    const lineProcessor = new LineProcessor();
    const startedAt = performance.now();
    for (let i = 1; i <= commandCount; i++) {
        const group = (i % 50) + 1;
        const line = `300-//PROJECT/254/56/${group}: level=255\n`;
        lineProcessor.processData(line, (commandLine) => {
            currentStart = performance.now();
            commandProcessor.processLine(commandLine);
        });
    }
    await Promise.all(pendingFlushes);
    const elapsedMs = performance.now() - startedAt;
    lineProcessor.close();

    return {
        profile: profile.name,
        sampleCount: commandCount,
        throughputMsgsPerSec: Number(((commandCount / elapsedMs) * 1000).toFixed(2)),
        lineToPublishCallMs: roundMetrics(summarize(lineToPublishCallLatencies)),
        lineToPublishFlushMs: roundMetrics(summarize(lineToPublishFlushLatencies))
    };
}

describe('Latency benchmark (mocked)', () => {
    test('collects latency baseline metrics and writes artifact', async () => {
        const config = loadBenchmarkConfig();
        const profile = {
            name: config.variant,
            logLevel: config.logLevel,
            eventPublishDedupWindowMs: config.dedupWindowMs
        };

        for (let i = 0; i < config.warmup; i++) {
            await runEventPathBenchmark(profile, config);
            await runCommandPathBenchmark(profile, config);
        }

        const cpuStart = process.cpuUsage();
        const rssBefore = process.memoryUsage().rss;
        const trials = [];
        for (let i = 0; i < config.repeat; i++) {
            const eventPath = await runEventPathBenchmark(profile, config);
            const commandPath = await runCommandPathBenchmark(profile, config);
            trials.push({ run: i + 1, eventPath, commandPath });
        }
        const cpuDiff = process.cpuUsage(cpuStart);
        const rssAfter = process.memoryUsage().rss;
        const representative = pickRepresentativeTrial(trials, 'eventPath') || trials[0];

        const artifact = {
            generatedAt: new Date().toISOString(),
            profile: profile.name,
            benchmarkConfig: {
                repeat: config.repeat,
                warmup: config.warmup,
                logLevel: profile.logLevel,
                dedupWindowMs: profile.eventPublishDedupWindowMs,
                eventCount: config.eventCount,
                commandCount: config.commandCount,
                uniqueGroups: config.uniqueGroups
            },
            summary: summarizeTrials(trials),
            workload: {
                eventCount: representative.eventPath.sampleCount,
                commandCount: representative.commandPath.sampleCount
            },
            resource: {
                cpuUserMs: Number((cpuDiff.user / 1000).toFixed(3)),
                cpuSystemMs: Number((cpuDiff.system / 1000).toFixed(3)),
                rssBeforeMb: Number((rssBefore / 1024 / 1024).toFixed(2)),
                rssAfterMb: Number((rssAfter / 1024 / 1024).toFixed(2))
            },
            eventPath: representative.eventPath,
            commandPath: representative.commandPath,
            trials
        };

        const artifactPath = process.env.PERF_ARTIFACT || path.join('perf', `${profile.name}.json`);
        ensureDir(artifactPath);
        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

        expect(representative.eventPath.lineToPublishCallMs.count).toBeGreaterThan(0);
        expect(representative.commandPath.lineToPublishCallMs.count).toBeGreaterThan(0);
    }, 60000);
});

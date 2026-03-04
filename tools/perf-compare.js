#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pctDelta(before, after) {
    if (!before) return 0;
    return ((after - before) / before) * 100;
}

function formatDelta(before, after, invertGood = false) {
    const delta = pctDelta(before, after);
    const good = invertGood ? delta <= 0 : delta >= 0;
    const sign = delta >= 0 ? '+' : '';
    return `${after.toFixed(3)} (${sign}${delta.toFixed(2)}%, ${good ? 'better' : 'worse'})`;
}

function getP95(bundle, pathName) {
    return bundle[pathName].lineToPublishFlushMs.p95;
}

function printSection(title) {
    process.stdout.write(`\n${title}\n`);
    process.stdout.write(`${'-'.repeat(title.length)}\n`);
}

function main() {
    const baselineFile = process.argv[2] || path.join('perf', 'baseline.json');
    const afterFile = process.argv[3] || path.join('perf', 'after.json');
    const maxP95RegressionPct = Number(process.env.PERF_MAX_P95_REGRESSION || 10);

    const baseline = readJson(baselineFile);
    const after = readJson(afterFile);

    process.stdout.write('Performance comparison report\n');
    process.stdout.write(`Baseline: ${baselineFile}\n`);
    process.stdout.write(`After:    ${afterFile}\n`);

    printSection('Event path');
    process.stdout.write(`Throughput msg/s: ${formatDelta(baseline.eventPath.throughputMsgsPerSec, after.eventPath.throughputMsgsPerSec, false)}\n`);
    process.stdout.write(`Line->Publish p95 ms: ${formatDelta(baseline.eventPath.lineToPublishCallMs.p95, after.eventPath.lineToPublishCallMs.p95, true)}\n`);
    process.stdout.write(`Line->Flush p95 ms: ${formatDelta(baseline.eventPath.lineToPublishFlushMs.p95, after.eventPath.lineToPublishFlushMs.p95, true)}\n`);
    if (baseline.eventPath.publishStats && after.eventPath.publishStats) {
        process.stdout.write(`Published msgs: baseline=${baseline.eventPath.publishStats.published}, after=${after.eventPath.publishStats.published}\n`);
        process.stdout.write(`Dedup dropped: baseline=${baseline.eventPath.publishStats.dedupDropped}, after=${after.eventPath.publishStats.dedupDropped}\n`);
    }

    printSection('Command path');
    process.stdout.write(`Throughput msg/s: ${formatDelta(baseline.commandPath.throughputMsgsPerSec, after.commandPath.throughputMsgsPerSec, false)}\n`);
    process.stdout.write(`Line->Publish p95 ms: ${formatDelta(baseline.commandPath.lineToPublishCallMs.p95, after.commandPath.lineToPublishCallMs.p95, true)}\n`);
    process.stdout.write(`Line->Flush p95 ms: ${formatDelta(baseline.commandPath.lineToPublishFlushMs.p95, after.commandPath.lineToPublishFlushMs.p95, true)}\n`);

    printSection('Resource');
    process.stdout.write(`CPU user ms: baseline=${baseline.resource.cpuUserMs.toFixed(3)}, after=${after.resource.cpuUserMs.toFixed(3)}\n`);
    process.stdout.write(`CPU system ms: baseline=${baseline.resource.cpuSystemMs.toFixed(3)}, after=${after.resource.cpuSystemMs.toFixed(3)}\n`);
    process.stdout.write(`RSS after MB: baseline=${baseline.resource.rssAfterMb.toFixed(2)}, after=${after.resource.rssAfterMb.toFixed(2)}\n`);

    const eventP95Regression = pctDelta(getP95(baseline, 'eventPath'), getP95(after, 'eventPath'));
    if (eventP95Regression > maxP95RegressionPct) {
        process.stderr.write(`\nFAIL: event path p95 regressed by ${eventP95Regression.toFixed(2)}% (threshold ${maxP95RegressionPct}%)\n`);
        process.exit(1);
    }

    process.stdout.write('\nPASS: p95 regression guardrail satisfied.\n');
}

main();

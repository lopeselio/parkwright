// Azure Application Insights, preloaded with `node --import` so HTTP, Redis and outgoing calls are
// instrumented before anything else loads. Off unless APPLICATIONINSIGHTS_CONNECTION_STRING is set
// (it is a Container App secret; scripts/set-insights-secret.sh). Nothing about players is recorded
// beyond what the platform sees anyway: routes, status codes, timings and exceptions.
const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
if (conn) {
  const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString: conn },
    // Sample a quarter of requests: plenty for a small game, a fraction of the ingestion cost.
    samplingRatio: Number(process.env.INSIGHTS_SAMPLING ?? 0.25),
    enableLiveMetrics: true,
  });
  process.env.OTEL_SERVICE_NAME ??= 'parkwright';
  console.log('[insights] Application Insights on');
}
export {};

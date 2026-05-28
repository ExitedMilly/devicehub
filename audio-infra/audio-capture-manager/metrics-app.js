'use strict';

// Bridge between the generic metrics store and DeviceHub domain.
// - registerAppMetrics(): declare HELP/TYPE so metrics show even at zero
// - collectGauges(): pull current state from stores into gauges (called
//   before each render — gauges reflect "now", no manual inc/dec needed)

const { registerCounter, registerGauge, setGauge } = require('./metrics');
const { instances, micRtcInstances, cameraInstances, gpsSessions } = require('./stores');
const { getCacheSize } = require('./http/ownership');

function registerAppMetrics() {
    registerGauge('capture_mgr_active_instances',
        'Number of active media instances by kind');
    registerGauge('capture_mgr_gps_sessions',
        'Number of active GPS keepalive sessions');
    registerGauge('capture_mgr_ownership_cache_size',
        'Number of entries in the ownership positive cache');
    registerCounter('capture_mgr_ownership_checks_total',
        'Total ownership checks by result');
    registerCounter('capture_mgr_ownership_cache_hits_total',
        'Total ownership cache hits');
    registerCounter('capture_mgr_http_requests_total',
        'Total HTTP requests by method');
    registerCounter('capture_mgr_ws_connections_total',
        'Total WebSocket connections by endpoint');
}

function collectGauges() {
    setGauge('capture_mgr_active_instances', { kind: 'audio' }, instances.size);
    setGauge('capture_mgr_active_instances', { kind: 'mic' }, micRtcInstances.size);
    setGauge('capture_mgr_active_instances', { kind: 'camera' }, cameraInstances.size);
    setGauge('capture_mgr_gps_sessions', {}, gpsSessions.size);
    setGauge('capture_mgr_ownership_cache_size', {}, getCacheSize());
}

module.exports = { registerAppMetrics, collectGauges };

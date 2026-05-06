'use strict';

// Video routes are handled via WebSocket in the WS block; nothing to handle over HTTP.
function handleVideo(_req, _res, _url) {
    return false;
}

module.exports = { handleVideo };

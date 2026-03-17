#!/bin/bash
curl -sf http://localhost:${MANAGER_PORT:-7600}/api/health >/dev/null 2>&1

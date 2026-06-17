'use strict';

const instances = new Map();           // serial → CaptureInstance (audio output)
const micRtcInstances = new Map();     // serial → WebRTCMicrophoneInstance
const cameraInstances = new Map();     // serial → CameraInstance
const gpsSessions = new Map();         // serial → keepalive session
const poseStates = new Map();          // serial → last applied pose
const lightStates = new Map();         // serial → last applied light state
const batteryStates = new Map();       // serial → last read battery state

module.exports = { instances, micRtcInstances, cameraInstances, gpsSessions, poseStates, lightStates, batteryStates };

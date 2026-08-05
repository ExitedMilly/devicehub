'use strict';

const { setNumber, getNumber } = require('../domain/phonenumber');
const log = require('../log').getLogger('http/routes-phonenumber');
const { readJsonBody } = require('./helpers');
const { isSerialAllowed, INSTANCE_SERIAL } = require('../config');

/**
 * @openapi
 * /phonenumber/{serial}:
 *   get:
 *     tags: [device]
 *     operationId: getPhoneNumber
 *     summary: Read the phone number the device currently reports
 *     description: |
 *       Reads the subscriber number with
 *       `adb shell su 0 service call iphonesubinfo 15` and extracts the digits from the returned
 *       Parcel dump.
 *
 *       **Parsing is best-effort.** The number is recovered from the quoted ASCII columns of the
 *       dump, so `number` is `null` whenever fewer than seven digits can be pulled out of it, and
 *       `raw` carries the untouched dump so the caller can inspect it. A failed or unavailable
 *       read is not an error either — it also comes back as `200` with `number` and `raw` null.
 *
 *       Read-only; safe to call at any time.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     responses:
 *       '200':
 *         description: |
 *           Read completed. `number` may be `null` when the parcel could not be parsed — the
 *           status code alone does not tell you the number was found.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PhoneNumberState' }
 *             examples:
 *               parsed:
 *                 summary: Number recovered
 *                 value:
 *                   ok: true
 *                   number: '79001234567'
 *                   raw: "Result: Parcel(00000000 0000000b '............' 00370039 ...)"
 *               unparsed:
 *                 summary: Read succeeded but nothing usable came back
 *                 value: { ok: true, number: null, raw: 'Result: Parcel(00000000 00000000 ..)' }
 *       '400':
 *         description: |
 *           Rare. The read path swallows adb failures and degrades to `number: null`, so this
 *           only appears when the request itself cannot be handled.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'device offline' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 *
 *   post:
 *     tags: [device]
 *     operationId: setPhoneNumber
 *     summary: Override the phone number the device reports at runtime
 *     description: |
 *       **Live device.** Sends `phonenumber <digits>` over the emulator telnet console, which
 *       changes the number the running device reports to apps immediately. Try-it-out on an
 *       instance somebody is using will change their number under them.
 *
 *       **This is a temporary override, not the instance's number.** The instance default comes
 *       from `instances.yaml` and is baked into the SIM profile by the emulator op-shim
 *       (`EF_MSISDN` in `iccprofile_for_sim0.xml`) at container creation, which is why it survives
 *       radio init. What this endpoint writes sits on top of that and is lost as soon as the SIM
 *       is re-read or the emulator restarts, at which point the baked default comes back. To
 *       change the number permanently, recreate the instance with a different value in
 *       `instances.yaml`.
 *
 *       **The value must be 7 to 15 digits with no leading `+`.** Anything else is rejected with
 *       400 before the console is touched; the console itself answers `KO` to a leading plus.
 *
 *       The response echoes the number that was sent — `{ ok: true, number }` with no `raw` field.
 *       It is not a verification read, so follow with `GET /phonenumber/{serial}` if you need to
 *       confirm what the device now reports.
 *     parameters:
 *       - $ref: '#/components/parameters/Serial'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PhoneNumberRequest' }
 *           examples:
 *             russianMobile:
 *               summary: Russian mobile number, digits only
 *               value: { number: '79001234567' }
 *     responses:
 *       '200':
 *         description: Override applied. The body echoes the number that was sent.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PhoneNumberState' }
 *             example: { ok: true, number: '79001234567' }
 *       '400':
 *         description: |
 *           The number failed validation (not 7-15 digits, or a leading `+`), or the console
 *           command could not be delivered.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorOkFalse' }
 *             example: { ok: false, error: 'number must be 7-15 digits (no leading +)' }
 *       '401': { $ref: '#/components/responses/Unauthorized' }
 *       '403': { $ref: '#/components/responses/ForbiddenSingleMode' }
 *       '503': { $ref: '#/components/responses/OwnershipUnavailable' }
 */
function handlePhonenumber(req, res, url) {
    const match = url.pathname.match(/^\/api\/phonenumber\/(.+)$/);
    if (!match) {
        return false;
    }

    const serial = decodeURIComponent(match[1]);
    if (!isSerialAllowed(serial)) {
        log.info({ serial, instanceSerial: INSTANCE_SERIAL, endpoint: req.url }, 'Serial not allowed in single mode');
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Serial not allowed in single mode', expected: INSTANCE_SERIAL }));
        return true;
    }

    if (req.method === 'GET') {
        getNumber(serial)
            .then((state) => {
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to read phone number');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    if (req.method === 'POST') {
        readJsonBody(req)
            .then(async (body) => {
                const state = await setNumber(serial, body.number);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, ...state }));
            })
            .catch((err) => {
                log.error({ serial, err: err.message }, 'Failed to set phone number');
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        return true;
    }

    return false;
}

module.exports = { handlePhonenumber };

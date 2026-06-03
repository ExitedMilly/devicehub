import local from '../../units/auth/local.js'
export const command = 'auth-local'
export const describe = 'Start a local auth unit that authenticates users by email and password.'
export const builder = function(yargs) {
    return yargs
        .env('STF_AUTH_LOCAL')
        .strict()
        .option('app-url', {
            alias: 'a',
            describe: 'URL to the app unit.',
            type: 'string',
            demand: true
        })
        .option('port', {
            alias: 'p',
            describe: 'The port to bind to.',
            type: 'number',
            default: process.env.PORT || 7120
        })
        .option('secret', {
            alias: 's',
            describe: 'The secret to use for auth JSON Web Tokens. Anyone who ' +
            'knows this token can freely enter the system if they want, so keep ' +
            'it safe.',
            type: 'string',
            default: process.env.SECRET,
            demand: true
        })
        .option('ssid', {
            alias: 'i',
            describe: 'The name of the session ID cookie.',
            type: 'string',
            default: process.env.SSID || 'ssid'
        })
        .option('support', {
            alias: 'sl',
            describe: 'url which needed to access support',
            type: 'string',
            default: 'example.com'
        })
        .option('docsUrl', {
            alias: 'du',
            describe: 'url which needed to access docs',
            type: 'string',
            default: 'example.com'
        })
        .epilog('Each option can be be overwritten with an environment variable ' +
        'by converting the option to uppercase, replacing dashes with ' +
        'underscores and prefixing it with `STF_AUTH_LOCAL_` (e.g. ' +
        '`STF_AUTH_LOCAL_SECRET`). The MongoDB connection is configured via the ' +
        'standard MONGODB_* environment variables (e.g. MONGODB_PORT_27017_TCP, ' +
        'MONGODB_DB_NAME), same as the other DB-backed units.')
}
export const handler = function(argv) {
    return local({
        port: argv.port,
        secret: argv.secret,
        ssid: argv.ssid,
        appUrl: argv.appUrl,
        supportUrl: argv.support,
        docsUrl: argv.docsUrl
    })
}

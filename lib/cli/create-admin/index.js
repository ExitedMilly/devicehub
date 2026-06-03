import logger from '../../util/logger.js'
import db from '../../db/index.js'
import * as apiutil from '../../util/apiutil.js'
import * as UserModel from '../../db/models/user/model.js'
export const command = 'create-admin'
export const describe = 'Create an admin user with email+password (for auth-local seeding).'
export const builder = function(yargs) {
    return yargs
        .strict()
        .option('email', {
            describe: 'Email of the admin user to create.',
            type: 'string',
            demand: true
        })
        .option('password', {
            describe: 'Password for the admin user. Prefer the ADMIN_PASSWORD ' +
            'environment variable so the secret does not end up in shell history.',
            type: 'string',
            default: process.env.ADMIN_PASSWORD,
            demand: true
        })
        .option('name', {
            describe: 'Display name of the admin user (defaults to the email).',
            type: 'string'
        })
}
export const handler = function(argv) {
    const log = logger.createLogger('cli:create-admin')
    const email = argv.email
    const password = argv.password
    const name = argv.name || email || 'Admin'
    return db.connect()
        .then(() => UserModel.loadUser(email))
        .then((existing) => {
            if (existing) {
                // Idempotent: never overwrite an existing user (could clobber a
                // password or privilege). Just exit cleanly.
                log.warn('User "%s" already exists, not modifying', email)
                process.exit(0)
                return
            }
            // Explicit ADMIN privilege; password is the 5th arg (hashed by the
            // model, PR 1). Never log the password.
            return UserModel.createUser(email, name, '127.0.0.1', apiutil.ADMIN, password)
                .then(() => {
                    log.info('Created admin user "%s"', email)
                    process.exit(0)
                })
        })
        .catch((err) => {
            log.fatal('Admin user creation had an error:', err.stack)
            process.exit(1)
        })
}

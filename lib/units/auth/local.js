// @ts-nocheck
import http from 'http'
import express from 'express'
import validator from 'express-validator'
import bodyParser from 'body-parser'
import Promise from 'bluebird'
import logger from '../../util/logger.js'
import * as requtil from '../../util/requtil.js'
import * as jwtutil from '../../util/jwtutil.js'
import * as pathutil from '../../util/pathutil.cjs'
import lifecycle from '../../util/lifecycle.js'
import rateLimitConfig from '../ratelimit/index.js'
import db from '../../db/index.js'
import {ONE_DAY} from '../../util/apiutil.js'
import * as UserModel from '../../db/models/user/model.js'
export default (async function(options) {
    const log = logger.createLogger('auth-local')

    // This provider runs as its own process and must query Mongo for the user's
    // password hash. db.connect() with no args opens the connection lazily using
    // the MONGODB_* env vars (no ZMQ/change-handlers/scheduler needed for reads),
    // mirroring the other DB-backed auth providers (saml2, oauth2).
    await db.connect()

    let app = express()
    let server = Promise.promisifyAll(http.createServer(app))
    lifecycle.observe(function() {
        log.info('Waiting for client connections to end')
        return server.closeAsync()
            .catch(function() {
            // Okay
            })
    })
    app.use(function(req, res, next) {
        res.setHeader('X-devicehub-unit', 'auth-local')
        next()
    })
    app.set('strict routing', true)
    app.set('case sensitive routing', true)
    app.use(rateLimitConfig)
    app.use(bodyParser.json())

    app.use(validator())
    app.get('/', function(req, res) {
        res.redirect('/auth/local/')
    })
    app.get('/auth/contact', function(req, res) {
        res.status(200)
            .json({
                success: true,
                contactUrl: options.supportUrl
            })
    })
    app.get('/auth/docs', function(req, res) {
        res.status(200)
            .json({
                success: true,
                docsUrl: options.docsUrl
            })
    })
    app.get('/', function(req, res) {
        res.redirect('/#/auth/local/')
    })
    app.get('/auth/local/*', (req, res) => {
        res.sendFile(pathutil.reactFrontend('dist/auth/auth-local.html'))
    })
    app.post('/auth/api/v1/local', function(req, res) {
        const log = logger.createLogger('auth-local')
        log.setLocalIdentifier(req.ip)
        if (req.accepts(['json']) !== 'json') {
            res.send(406)
            return
        }

        requtil.validate(req, function() {
            req.checkBody('email').isEmail()
            req.checkBody('password').notEmpty()
        })
            .then(function() {
                const email = req.body.email
                const password = req.body.password
                return UserModel.verifyPassword(email, password).then(function(ok) {
                    if (!ok) {
                        // SINGLE generic failure — do NOT reveal whether the user
                        // exists, has no password, or the password was wrong.
                        // verifyPassword returns false uniformly for all cases and
                        // uses bcrypt.compare (constant-time) as the only check.
                        log.warn('Authentication failure for "%s"', email)
                        return res.status(401).json({
                            success: false,
                            error: 'InvalidCredentialsError'
                        })
                    }
                    return UserModel.loadUser(email).then(function(user) {
                        const privilege = user.privilege
                        const name = user.name
                        log.info('Authenticated "%s" with privilege "%s"', email, privilege)
                        const token = jwtutil.encode({
                            payload: {
                                email: email,
                                name: name,
                                privilege: privilege
                            },
                            secret: options.secret,
                            header: {
                                exp: Date.now() + ONE_DAY
                            }
                        })
                        return res.status(200).json({
                            success: true,
                            jwt: token,
                            redirect: options.appUrl
                        })
                    })
                })
            })
            .catch(requtil.ValidationError, function(err) {
                res.status(400).json({
                    success: false,
                    error: 'ValidationError',
                    validationErrors: err.errors
                })
            })
            .catch(function(err) {
                log.error('Unexpected error', err.stack)
                res.status(500).json({
                    success: false,
                    error: 'ServerError'
                })
            })
    })
    server.listen(options.port)
    log.info('Listening on port %d', options.port)
})

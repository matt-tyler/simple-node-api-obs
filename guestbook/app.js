const serverless = require('serverless-http');
const express = require('express');
const s3 = require('aws-sdk/clients/s3');
const v5 = require('uuid/v5');
const env = require('env-var');
const bodyParser = require('body-parser');
const rbac = require('./rbac');
const jwt = require('jsonwebtoken')
const newLogger = require('pino');
const xray = require('aws-xray-sdk');

const app = new express();

const plainTextParser = bodyParser.text();

const methodToAction = {
    GET: 'read',
    PUT: 'write',
    POST: 'write',
    DELETE: 'delete'
}

app.use((req, res, next) => {
    req['segment'] = xray.getSegment();
    req['logger'] = newLogger();
    next();
});

app.use((req, res, next) => {
    const { headers, segment, method, logger, path: obj } = req;
    xray.captureAsyncFunc('Auth Middleware', subsegment => {
        const token = headers['authorization'];
        const decoded = jwt.decode(token, { json: true });
        const { sub } = decoded;
        const groups = decoded['cognito:groups'] || [];
        const act = methodToAction[method];
        req.logger = req.logger.child({ sub, obj, act, groups })
        rbac.addRolesToUser(sub, groups).then(() => {
            rbac.enforce(sub, obj, act)
                .then(pass => {
                    req.logger.info("Evaluating Access");
                    subsegment.close();
                    if (pass) {
                        req.logger.info("Access Allowed");
                        next()
                    } else {
                        req.logger.info("Access Denied");
                        res.status(403).json({ message: 'Forbidden' });
                    }
                })
        }).catch(() => subsegment.close());
    }, segment);
});

app.use((err, req, res, next) => {
    req.logger(err);
    res.status(500).json({ message: 'Internal Server Error'});
});

function newS3Client() {
    return xray.captureAWSClient(
        new s3({ 
            params: { Bucket: env.get('BUCKET').required().asString() },
        })
    );
}

function getAuthor() {
    return 'anonymous';
}

app.get('/', ({ segment, query }, res) => {
    xray.captureAsyncFunc('Get Messages', subsegment => {
        const client = newS3Client();
        const maxItems = query.maxItems || 20;
        const token = query.token;
        getMessages(client, parseInt(maxItems), token).then(response => {
            res.status(200).json(response);
        }).finally(() => subsegment.close());
    }, segment);
});

app.post('/', plainTextParser, ({ segment, body: message }, res) => {
    xray.captureAsyncFunc('Create Message', subsegment => {
        const client = newS3Client();
        writeMessage(client, message, getAuthor()).then(response => {
            res.status(201).json(response);
        }).finally(() => subsegment.close());
    }, segment);
});

function ninesComplement(date) {
    return date.toISOString().split('')
        .map(c => {
            const n = parseInt(c);
            if (isNaN(n)) return c;
            else return (9 - n).toString()
        }).join('');
}

async function writeMessage(client, message, author) {
    const namespace = v5(author, v5.URL);
    const id = v5(message, namespace);
    const date = new Date();
    const Key = `${ninesComplement(date)}/${id}`;
    const body = { message, date: date.toISOString(), author };
    await client.putObject({ Key, Body: JSON.stringify(body) }).promise();
    return body;
}

async function getMessages(client, maxItems, token) {
    const { Contents, NextContinuationToken } = await client.listObjectsV2({
        MaxKeys: maxItems,
        ContinuationToken: token ?
            Buffer.from(token, 'base64').toString('ascii') : undefined
    }).promise();

    const res = await Promise.all(Contents
        .map(({ Key }) => client.getObject({ Key }).promise()));

    return {
        items: res.map(({ Body }) => JSON.parse(Body)),
        nextToken: NextContinuationToken ?
            Buffer.from(NextContinuationToken, 'ascii').toString('base64') : undefined
    }
}

module.exports.lambdaHandler = serverless(app);

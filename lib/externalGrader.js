const ERR = require('async-stacktrace');
const AWS = require('aws-sdk');
const fs = require('fs-extra');

const config = require('./config');
const logger = require('./logger');
const sqldb = require('./sqldb');
const sqlLoader = require('./sql-loader');
const externalGradingSocket = require('./external-grading-socket');
const ExternalGraderSqs = require('./externalGraderSqs');
const ExternalGraderLocal = require('./externalGraderLocal');

const sql = sqlLoader.loadSqlEquiv(__filename);

module.exports.init = function(assessment, callback) {
    module.exports.assessment = assessment;
    if (config.externalGradingUseAws) {
        // So, this is terrible, but AWS will look relative to the Node working
        // directory, not the current directory. So aws-config.json should be
        // in the project root.
        if (fs.existsSync('./aws-config.json')) {
            logger.info('Loading AWS credentials for external grading.');
            AWS.config.loadFromPath('./aws-config.json');
        } else {
            logger.info('Missing \'aws-config.json\' in project root; this should only matter for local development.');
        }

        AWS.config.update({region: 'us-east-2'});
        module.exports.grader = new ExternalGraderSqs();

        callback(null);
    } else {
        // local dev mode
        logger.info('Not loading AWS credentials; external grader running locally.');
        module.exports.grader = new ExternalGraderLocal();
        callback(null);
    }
};

module.exports.sendToGradingQueue = function(grading_job, submission, variant, question, course) {
    if (!question.external_grading_enabled) {
        logger.info('External grading disabled for job id: ' + grading_job.id);

        // Make the grade 0
        let ret = {
            gradingId: grading_job.id,
            grading: {
                score: 0,
                feedback: {
                    succeeded: true,
                    message: 'External grading is not enabled :(',
                },
            },
        };

        // Send the grade out for processing and display
        module.exports.assessment.processGradingResult(ret);
        return;
    }

    logger.info(`Submitting external grading job ${grading_job.id}.`);

    if (config.externalGradingUseAws) {
        // We should submit our grading job to AWS
        const gradeRequest = module.exports.grader.handleGradingRequest(grading_job, submission, variant, question, course);
        gradeRequest.on('submit', () => {
            updateJobSubmissionTime(grading_job.id, (err) => {
                if (ERR(err, () => logger.error(err))) return;
            });
            logger.info(`Successfully submitted grading job ${grading_job.id}`);
        });
        gradeRequest.on('error', (err) => {
            handleGraderError(grading_job.id, err);
        });
    } else {
        // local dev mode
        const gradeRequest = module.exports.grader.handleGradingRequest(grading_job, submission, variant, question, course);
        gradeRequest.on('submit', () => {
            updateJobSubmissionTime(grading_job.id, (err) => {
                if (ERR(err, () => logger.error(err))) return;
            });
        });
        gradeRequest.on('results', (gradingResult) => {
            module.exports.assessment.processGradingResult(gradingResult);
            logger.info(`Successfully processed grading job ${grading_job.id}`);
        });
        gradeRequest.on('error', (err) => {
            handleGraderError(grading_job.id, err);
        });
    }
};

function handleGraderError(jobId, err) {
    logger.error(`Error processing external grading job ${jobId}`);
    logger.error(err);
    const gradingResult = {
        gradingId: jobId,
        grading: {
            score: 0,
            startTime: null,
            endTime: null,
            feedback: {
                succeeded: false,
                message: err.toString()
            },
        },
    };
    module.exports.assessment.processGradingResult(gradingResult);
}

function updateJobSubmissionTime(grading_job_id, callback) {
    var params = {
        grading_job_id: grading_job_id,
    };
    sqldb.query(sql.update_grading_submitted_time, params, function(err, _result) {
        if (ERR(err, callback)) return;
        externalGradingSocket.gradingLogStatusUpdated(grading_job_id);
        callback(null);
    });
}

const AWS = require('aws-sdk');
const util = require('util');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const command = require('child_process').exec;
const {stringifySync} = require('@dmitrio/subtitle');

const region = 'us-east-1';

const s3 = new AWS.S3({region: region});
const dynamodb = new AWS.DynamoDB({region: region});
const meetingId = '5ea9553a-e68b-4c9e-9292-199baf690706';
const breakoutSessionId = '105';
const bucketName = 'us2-dev-i-video-breakout-room-recording';

const contentShare = "AttendeeVideoJoined";
const contentShareStop = "AttendeeVideoLeft";
const mediaModalityContent = "ContentShare";
const activeSpeaker = 'ActiveSpeaker';

let videoExist = false;

async function downloadChunks(meetingId) {
    const audioPrefix = `captures/${meetingId}/audio`;
    const videoPrefix = `captures/${meetingId}/video`;
    const eventsPrefix = `captures/${meetingId}/meeting-events`;
    let objects = [];

    async function listAllKeys(token) {
        const opts = {
            Bucket: bucketName,
            Prefix: `captures/${meetingId}/`
        };
        if (token) {
            opts.ContinuationToken = token;
        }

        const data = await s3.listObjectsV2(opts).promise()

        objects = objects.concat(data.Contents);

        if (data.IsTruncated) {
            await listAllKeys(data.NextContinuationToken);
        }
    }

    await listAllKeys();

    // todo add error handler
    const filteredAudioObjects = objects.filter((object) => object.Key.startsWith(audioPrefix));
    const filteredVideoObjects = objects.filter((object) => object.Key.startsWith(videoPrefix));
    const filteredEventsObjects = objects.filter((object) => object.Key.startsWith(eventsPrefix));

    if (filteredVideoObjects.length) {
        videoExist = true;
    }

    const audioPathFile = fs.createWriteStream(path.join(__dirname, `/tmp/audio${meetingId}.txt`));

    audioPathFile.on('error', function (err) { /* error handling */
    });

    const promisesWithAudio = [];
    const promisesWithVideo = [];
    const promisesWithEvents = [];

    const audioKeys = [];
    filteredAudioObjects.forEach((obj) => {
        const fileName = obj.Key.split(audioPrefix)
        audioKeys.push(fileName[1]);
        promisesWithAudio.push(
            s3.getObject({
                Bucket: bucketName,
                Key: obj.Key
            }).promise()
        );
    });
    const videoKeys = [];
    filteredVideoObjects.forEach((obj) => {
        const fileName = obj.Key.split(videoPrefix)
        videoKeys.push(fileName[1]);
        promisesWithVideo.push(
            s3.getObject({
                Bucket: bucketName,
                Key: obj.Key
            }).promise()
        );
    })
    const eventKeys = [];
    filteredEventsObjects.forEach((obj) => {
        const fileName = obj.Key.split(eventsPrefix)
        eventKeys.push(fileName[1]);
        promisesWithEvents.push(
            s3.getObject({
                Bucket: bucketName,
                Key: obj.Key
            }).promise()
        );
    })

    const resultsAudio = await Promise.all(promisesWithAudio);
    const resultsVideo = await Promise.all(promisesWithVideo);
    const resultsEvents = await Promise.all(promisesWithEvents);

    const partsAudio = resultsAudio.map((data) => data.Body);
    const partsVideo = resultsVideo.map((data) => data.Body);
    const partsEvents = resultsEvents.map((data) => data.Body);

    partsAudio.forEach((item, index) => {
        fs.writeFileSync(path.join(__dirname, `/tmp/audio/${audioKeys[index]}`), item);
        audioPathFile.write(`file '${path.join(__dirname, `/tmp/audio/${audioKeys[index]}`)}'` + '\n');
    })

    partsVideo.forEach((item, index) => {
        fs.writeFileSync(path.join(__dirname, `/tmp/video/${videoKeys[index]}`), item);
    });

    partsEvents.forEach((item, index) => {
        fs.writeFileSync(path.join(__dirname, `/tmp/event/${eventKeys[index]}`), item);
    });

    const audioPathFilePromisify = util.promisify(audioPathFile.end).bind(audioPathFile);
    await audioPathFilePromisify();
}

function addSubtitle(input, output) {
    return new Promise((resolve, reject) => {
        const inputPath = path.join(__dirname, `/tmp/${input}.mp4`);
        const outputPath = path.join(__dirname, `/tmp/${output}.mp4`);

        //ffmpeg -i in.mp4 -vf subtitles=sub.srt:force_style='Fontsize=20' out.mp4
        ffmpeg(inputPath)
            .outputOptions(`-vf ass=tmp/sub.ass`)
            .on('error', function (err) {
                console.log('Error: ' + err.message);
                reject();
            })
            .save(outputPath)
            .on('stderr', function (stderrLine) {
                console.log('Stderr output: ' + stderrLine);
            })
            .on('end', function () {
                console.log('Recording with text is ready!');
                resolve();
            })
    });
}

function fetchUsersData(endDate) {
    return new Promise((resolve, reject) => {
        // add search by meeting
        //const startDateParsed = new Date(new Date(startDate).setSeconds(new Date(startDate).getSeconds() - 1));
        const endDateParsed = new Date(new Date(endDate).setSeconds(new Date(endDate).getSeconds() + 1));

        const params = {
            ExpressionAttributeValues: {
                ":v1": {
                    N: breakoutSessionId
                },
                // ":startDate":{
                //     N: (+startDateParsed).toString()
                // },
                ":endDate": {
                    N: (+endDateParsed).toString()
                }
            },
            TableName: "us2-dev-i-breakout-session-events",
            ExpressionAttributeNames: {
                "#time": "timestamp"
            },
            KeyConditionExpression: "breakoutSessionId = :v1 AND #time <= :endDate", //#time BETWEEN :startDate AND :endDate
        };
        dynamodb.query(params, function (err, data) {
            if (err) {
                reject(err);
            } else {
                // TODO get start of meeting
                const usersData = data.Items.filter((item) => item.externalUserId).map((item) => {
                    return {
                        meetingId: item.meetingId.S,
                        timestamp: item.timestamp.N,
                        eventType: item.eventType.S,
                        externalUserId: item.externalUserId.S,
                        attendeeId: item.attendeeId.S
                    }
                });

                const attendeeJoined = usersData.filter(({
                                                             eventType,
                                                             meetingId: usersMeeting
                                                         }) => eventType === 'chime:AttendeeJoined' && usersMeeting === meetingId);
                const usernamesMap = new Map();

                console.log(attendeeJoined);
                attendeeJoined.forEach(({attendeeId, externalUserId}) => {
                    const prepareUserId = externalUserId.split(':')
                    usernamesMap.set(attendeeId, prepareUserId[1]);
                })

                resolve(usernamesMap);
            }
        });
    })
}

function concatContentChunks(pathToFile, pathToNewFile) {
    return new Promise((resolve, reject) => {
        const mergeContent = ffmpeg();

        const newPath = path.join(__dirname, `/tmp/${pathToNewFile}.mp4`)
        mergeContent.input(pathToFile)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c copy'])
            .save(newPath)
            .on('error', function (err) {
                console.log('Error: ' + err.message);
                reject();
            })
            .on('stderr', function (stderrLine) {
                console.log('Stderr output: ' + stderrLine);
            })
            .on('end', function () {
                console.log('concatContentChunks is ready!');
                resolve(newPath);
            })
    })
}

function concatMeetingParts(pathToFile, pathToNewFile) {
    return new Promise((resolve, reject) => {
        const concatVideo = ffmpeg();
        const newPath = path.join(__dirname, `/tmp/${pathToNewFile}.mp4`)
        concatVideo.input(pathToFile)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c copy'])
            .save(newPath)
            .on('error', function (err) {
                console.log('Error: ' + err.message);
                reject();
            })
            .on('stderr', function (stderrLine) {
                console.log('Stderr output: ' + stderrLine);
            })
            .on('end', function () {
                console.log('Finished processing video files');
                resolve();
            })
    })
}

async function workWithChunks() {
    function concatAudioAndVideo(audioPath, videoPath, index) {
        // ffmpeg -i 1.mp4 -i 2.mp4 -filter_complex "[1] scale=480:270 [over]; [0][over] overlay=1440:0" output.mp4
        const resultPathNotScaled = path.join(__dirname, `/tmp/${index}-not-scaled.mp4`);
        return new Promise((resolve, reject) => {
            command(`ffmpeg -i ${videoPath} -i ${audioPath} -filter_complex "[1] scale=480:270 [over]; [0][over] overlay=1440:0" ${resultPathNotScaled}`,
                function (err, res) {
                    console.log('concatAudioAndVideo!', resultPathNotScaled);
                    console.log(err);
                    if (!err) {
                        resolve()
                    }
                })
        }).then(() => {
            const resultPathScaled = path.join(__dirname, `/tmp/${index}.mp4`);
            return new Promise((resolve, reject) => {
                command(`ffmpeg -i ${resultPathNotScaled} -vf scale=1280:720 -filter:v fps=fps=14.98 ${resultPathScaled}`,
                    function (err, res) {
                        console.log('scale concatAudioAndVideo!', resultPathScaled);
                        console.log(err);
                        if (!err) {
                            resolve(resultPathScaled)
                        }
                    })
            })
        })
    }

    function convertEventToJson(txt) {
        const rxp = /{([^}]+)}/g;
        const searchStringArray = txt.match(rxp);
        let parsedValue;

        const data = [];
        searchStringArray.forEach((searchString) => {
            try {
                parsedValue = JSON.parse(searchString)
            } catch (e) {
                parsedValue = JSON.parse(searchString + '}')
            }

            data.push(parsedValue)
        })
        return data;
    }

    function convertAllEvents(files) {
        const allEvents = [];
        let mainStart;
        let mainEnd;
        files.forEach((file, index) => {
            const txt = fs.readFileSync(path.join(__dirname, `/tmp/event/${file}`), 'utf8');
            const parsedEvent = convertEventToJson(txt);

            if (index === 0) {
                mainStart = parsedEvent.find((item) => item.EventType === 'CaptureStarted').Timestamp;
            } else if (index === files.length - 1) {
                mainEnd = parsedEvent.find((item) => item.EventType === 'CaptureEnded').Timestamp;
            }

            allEvents.push(...parsedEvent);
        });

        return {
            allEvents,
            mainStart,
            mainEnd
        };
    }

    const eventsFolder = path.join(__dirname, `/tmp/event`);
    const files = fs.readdirSync(eventsFolder);

    const {allEvents, mainStart, mainEnd} = convertAllEvents(files);

    const userNamesMap = await fetchUsersData(mainStart, mainEnd);

    try {
        const convertedStartDate = new Date(mainStart);
        const contentPaths = [];

        let sharingScreen = false;

        let startBuff;
        let isStart = true;
        let endBuff;
        let attendeeId;
        let index = 0;
        const list = [];
        const endMilliseconds = new Date(mainEnd) - new Date(mainStart);

        const videoFolder = path.join(__dirname, `/tmp/video`);
        const audioFolder = path.join(__dirname, `/tmp/audio`);

        for (const event of allEvents) {

            // generate subtitle when user is not sharing screen
            if (event.EventType === activeSpeaker && !sharingScreen) {
                const attendeeId = event.EventParameters.AttendeeId;
                const diff = new Date(event.Timestamp) - new Date(mainStart);
                const text = userNamesMap.get(attendeeId) ? `${userNamesMap.get(attendeeId)} talking` : '';

                if (list.length === 0) {
                    list.push({
                        type: 'cue',
                        data: {
                            start: diff,
                            text,
                            settings: ''
                        }
                    })
                } else {
                    list[list.length - 1].data.end = diff;
                    list.push({
                        type: 'cue',
                        data: {
                            start: diff,
                            text,
                            settings: ''
                        }
                    });
                }
            }

            // generate subtitle when user is sharing screen
            if (event.EventType === activeSpeaker && sharingScreen) {
                const attendeeId = event.EventParameters.AttendeeId;
                const diff = new Date(event.Timestamp) - new Date(mainStart);
                const text = userNamesMap.get(attendeeId) ? `${userNamesMap.get(attendeeId)}` : '';

                if (list.length === 0) {
                    list.push({
                        type: 'cue',
                        data: {
                            start: diff,
                            text,
                            settings: 'X1:600 X2:625 Y1:100 Y2:100'
                        }
                    })
                } else {
                    list[list.length - 1].data.end = diff;
                    list.push({
                        type: 'cue',
                        data: {
                            start: diff,
                            text,
                            settings: 'X1:600 X2:625 Y1:100 Y2:100'
                        }
                    });
                }
            }

            if (event.EventType === contentShare && event.EventParameters) {
                if (event.EventParameters.MediaModality === mediaModalityContent) {
                    startBuff = event.Timestamp;

                    attendeeId = event.EventParameters.AttendeeId;

                    sharingScreen = true;

                    if (isStart) {
                        const pathToFile = path.join(__dirname, `/tmp/${index}.txt`);
                        let resultFile = fs.createWriteStream(pathToFile);
                        resultFile.on('error', function (err) {
                        });

                        contentPaths.push({
                            pathToFile,
                            index,
                        });

                        await writeToFile(resultFile, audioFolder, new Date(mainStart), new Date(startBuff));
                        isStart = false;
                    } else {
                        const pathToFile = path.join(__dirname, `/tmp/${index}.txt`);
                        let resultFile = fs.createWriteStream(pathToFile);
                        resultFile.on('error', function (err) {
                        });

                        contentPaths.push({
                            pathToFile,
                            index,
                        });

                        await writeToFile(resultFile, audioFolder, new Date(endBuff), new Date(startBuff));
                    }
                }
            }

            if (event.EventType === contentShareStop && event.EventParameters) {
                if (event.EventParameters.MediaModality === mediaModalityContent) {
                    endBuff = event.Timestamp;

                    sharingScreen = false;

                    if (new Date(endBuff) < convertedStartDate) {
                        endBuff = findClosestCorrectDate(allEvents, index, convertedStartDate);
                    }

                    const pathToFileAudio = path.join(__dirname, `/tmp/${index}-audio.txt`);
                    const pathToFileVideo = path.join(__dirname, `/tmp/${index}-video.txt`);

                    let resultFileAudio = fs.createWriteStream(pathToFileAudio);
                    resultFileAudio.on('error', function (err) {
                    });
                    let resultFileVideo = fs.createWriteStream(pathToFileVideo);
                    resultFileVideo.on('error', function (err) {
                    });

                    contentPaths.push({
                        type: 'concat',
                        index,
                        video: {
                            pathToFile: pathToFileVideo,
                        },
                        audio: {
                            pathToFile: pathToFileAudio,
                        }
                    });

                    await writeToFile(resultFileAudio, audioFolder, new Date(startBuff), new Date(endBuff));
                    await writeToFile(resultFileVideo, videoFolder, new Date(startBuff), new Date(endBuff));
                }
            }

            if (index === allEvents.length - 1) {
                const pathToFile = path.join(__dirname, `/tmp/${index}.txt`);
                let resultFile = fs.createWriteStream(pathToFile);
                resultFile.on('error', function (err) {
                });

                contentPaths.push({
                    pathToFile,
                    index,
                });

                await writeToFile(resultFile, audioFolder, new Date(endBuff), new Date(mainEnd));
            }
            index += 1;
        }

        if (list.length) {
            list[list.length - 1].data.end = endMilliseconds;
        }
        let prevIndex = 1;
        list.forEach((item, index) => {
             if (index > 0) {
                 if(list[index - prevIndex].data.settings !== item.data.settings) {
                     const end = list[index - prevIndex].data.end;
                     const start = item.data.start;

                     if (start - end > 1000) return;

                     list[index - prevIndex].data.end = prevIndex > 1 ? end : end - 200;
                     item.data.start = prevIndex > 1 ? end + 1000 : start + 800;

                     const newStart = item.data.start;

                     if (newStart > item.data.end) {
                         delete list[index];
                         prevIndex += 1
                     } else {
                         prevIndex = 1;
                     }
                 }
             }
        });

        list.filter((item) => item);

        // generate sub
        fs.writeFileSync(path.join(__dirname, `/tmp/sub.srt`), stringifySync(list, {format: 'SRT'}));

        const resultFilePath = path.join(__dirname, `/tmp/${meetingId}.txt`)
        const resultFile = fs.createWriteStream(resultFilePath);
        resultFile.on('error', function (err) {
        });
        const resultFileEnd = util.promisify(resultFile.end).bind(resultFile);

        for (const item of contentPaths) {
            let newPath;

            if (item.type) {
                const audioPath = await concatContentChunks(item.audio.pathToFile, `audio-${item.index}`)
                const videoPath = await concatContentChunks(item.video.pathToFile, `video-${item.index}`)

                const resultPath = await concatAudioAndVideo(audioPath, videoPath, item.index)
                newPath = resultPath;
            } else {
                newPath = await concatContentChunks(item.pathToFile, item.index)
            }

            resultFile.write(`file '${newPath}'` + '\n')

            item.pathToFile = newPath;
        }

        await resultFileEnd();

        console.log('Concat Meeting Parts finale!')
        await concatMeetingParts(resultFilePath, `${meetingId}-no-sub`);
        console.log('Concat Meeting Parts done!')

        console.log('Add subtitle!');
        await addSubtitle(`${meetingId}-no-sub`, `${meetingId}-with-sub`);
        console.log('Subtitle was added!');

        async function writeToFile(resultFile, folder, dateStart, dateEnd) {
            const files = fs.readdirSync(folder);
            const resultFileNames = files.filter((fileName) => {
                const fileNameWithoutExtension = fileName.replace(/\.[^/.]+$/, "");
                const buff = fileNameWithoutExtension.split('-');
                const convertedDate = `${buff[0]}-${buff[1]}-${buff[2]}T${buff[3]}:${buff[4]}:${buff[5]}.${buff[6]}+00:00`

                const dateItem = new Date(convertedDate);
                return dateItem > dateStart && dateItem < dateEnd;
            });

            resultFileNames.forEach((fileName) => resultFile.write(`file '${path.join(folder, `/${fileName}`)}'` + '\n'));
            const resultFileEnd = util.promisify(resultFile.end).bind(resultFile);
            await resultFileEnd();
        }

        function findClosestCorrectDate(allEvents, index, convertedStartDate) {
            if (new Date(allEvents[index].Timestamp) < convertedStartDate) {
                return findClosestCorrectDate(allEvents, index + 1, convertedStartDate);
            }

            return new Date(allEvents[index].Timestamp);
        }
    } catch (err) {
        console.log(err)
    }

}

downloadChunks(meetingId)
    .then(workWithChunks).then(() => {
    console.log('Done')
})
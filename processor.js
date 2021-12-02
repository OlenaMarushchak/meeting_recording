const AWS = require("aws-sdk");
const util = require("util");
const fs = require("fs");
const { spawn } = require("child_process");

const ffmpeg = require("fluent-ffmpeg");
const { stringifySync } = require("@dmitrio/subtitle");

const REGION = process.env.AWS_REGION || "us-east-1";

const MEETING_ID = process.env.MEETING_ID;
const SESSION_ID = String(process.env.SESSION_ID);
const EVENTS_TABLE_NAME = process.env.EVENTS_TABLE_NAME;

const MEETING_RECORDING_PATH = `/tmp/${MEETING_ID}`;
const AUDIO_PATH = `${MEETING_RECORDING_PATH}/audio`;
const VIDEO_PATH = `${MEETING_RECORDING_PATH}/video`;
const MEETING_EVENTS_PATH = `${MEETING_RECORDING_PATH}/meeting-events`;
const SRT_PATH = `${MEETING_RECORDING_PATH}/sub.srt`;
const FFMPEG_FILE_LIST_INPUT = `${MEETING_RECORDING_PATH}/ffmpeg-input.txt`;

const DDB = new AWS.DynamoDB({ region: REGION });

const attendeeJoinedEventType = "chime:AttendeeJoined";
const AttendeeVideoJoined = "AttendeeVideoJoined";
const AttendeeVideoLeft = "AttendeeVideoLeft";
const ContentShare = "ContentShare";
const ActiveSpeaker = "ActiveSpeaker";

function execFFMPEG (args) {
  return new Promise(function (resolve, reject) {
    console.log(`Running a command: ffmpeg ${args.join(" ")}`);
    const process = spawn("ffmpeg", args, { stdio: "inherit" });
    process.on("close", function (code) {
      resolve(code);
    });
    process.on("error", function (err) {
      reject(err);
    });
  });
}

function fetchUsersData (endDate) {
  return new Promise((resolve, reject) => {
    const params = {
      FilterExpression: "eventType = :eventType AND meetingId = :meetingId",
      KeyConditionExpression: "breakoutSessionId = :breakoutSessionId",
      ExpressionAttributeValues: {
        ":breakoutSessionId": {
          N: SESSION_ID
        },
        ":eventType": {
          S: attendeeJoinedEventType
        },
        ":meetingId": {
          S: MEETING_ID
        }
      },
      TableName: EVENTS_TABLE_NAME
    };
    DDB.query(params, function (err, data) {
      if (err) {
        reject(err);
      } else {
        const usersData = data.Items.filter((item) => item.externalUserId)
          .map((item) => ({
            meetingId: item.meetingId.S,
            timestamp: item.timestamp.N,
            eventType: item.eventType.S,
            externalUserId: item.externalUserId.S,
            attendeeId: item.attendeeId.S
          }));

        const usernamesMap = new Map();
        usersData.forEach(({ attendeeId, externalUserId }) => {
          const [, username] = externalUserId.split(":");
          if (!username) return;
          usernamesMap.set(attendeeId, username);
        });
        resolve(usernamesMap);
      }
    });
  });
}

function concatContentChunks (pathToFile, pathToNewFile) {
  return new Promise((resolve, reject) => {
    const mergeContent = ffmpeg();
    const newPath = `${MEETING_RECORDING_PATH}/${pathToNewFile}.mp4`;
    mergeContent.input(pathToFile)
      .inputOptions("-f", "concat", "-safe", "0")
      .outputOptions("-c", "copy")
      .save(newPath)
      .on("error", function (err) {
        console.log("Error: " + err.message);
        reject(err);
      })
      .on("stderr", function (stderrLine) {
        console.log(stderrLine);
      })
      .on("end", function () {
        console.log(`Concatenation of ${pathToFile} is done. Output is ${newPath}`);
        resolve(newPath);
      });
  });
}

async function concatAudioAndVideo (audioPath, videoPath, index) {
  const resultPathNotScaled = `${MEETING_RECORDING_PATH}/${index}-not-scaled.mp4`;
  const resultPathScaled = `${MEETING_RECORDING_PATH}/${index}.mp4`;

  try {
    await execFFMPEG(["-i", videoPath, "-i", audioPath, "-filter_complex", "[1] scale=480:270 [over]; [0][over] overlay=1440:0", resultPathNotScaled]);
    console.log(`Concatenation of ${audioPath} and ${videoPath} is done. Output is ${resultPathNotScaled}`);
    await execFFMPEG(["-i", resultPathNotScaled, "-vf", "scale=1280:720", "-filter:v", "fps=fps=14.98", resultPathScaled]);
    console.log(`Scaling of ${resultPathScaled} is done. Output is ${resultPathScaled}`);
    return resultPathScaled;
  } catch (err) {
    console.error("An error occurred", err);
    throw err;
  }
}

function convertEventToJson (txt) {
  const rxp = /{([^}]+)}/g;
  const searchStringArray = txt.match(rxp);
  let parsedValue;

  const data = [];
  searchStringArray.forEach((searchString) => {
    try {
      parsedValue = JSON.parse(searchString);
    } catch (e) {
      parsedValue = JSON.parse(searchString + "}");
    }
    data.push(parsedValue);
  });
  return data;
}

function convertAllEvents (files) {
  const allEvents = [];
  let mainStart;
  let mainEnd;
  files.forEach((file, index) => {
    const txt = fs.readFileSync(file, "utf8");
    const parsedEvent = convertEventToJson(txt);

    if (index === 0) {
      mainStart = parsedEvent.find((item) => item.EventType === "CaptureStarted").Timestamp;
    } else if (index === files.length - 1) {
      mainEnd = parsedEvent.find((item) => item.EventType === "CaptureEnded").Timestamp;
    }

    allEvents.push(...parsedEvent);
  });

  return {
    allEvents,
    mainStart,
    mainEnd
  };
}

async function writeToFile (file, folder, dateStart, dateEnd) {
  const files = fs.readdirSync(folder);

  const resultFileNames = files.map(v => `${folder}/${v}`)
    .filter((fileName) => {
      const fileNameWithoutExtension = fileName.replace(/\.[^/.]+$/, "");
      const buff = fileNameWithoutExtension.split("/").pop().split("-");

      const convertedDate = `${buff[0]}-${buff[1]}-${buff[2]}T${buff[3]}:${buff[4]}:${buff[5]}.${buff[6]}+00:00`;

      const dateItem = new Date(convertedDate);
      return dateItem > dateStart && dateItem < dateEnd;
    });

  if (!resultFileNames.length) {
    console.log("No files found anymore");
    return null;
  }

  const resultFile = fs.createWriteStream(file);
  resultFile.on("error", function (err) {
    console.log("An error occurred", err);
  });

  resultFileNames.forEach((fileName) => resultFile.write(`file '${fileName}'` + "\n"));

  await util.promisify(resultFile.end).bind(resultFile);

  return file;
}

function findClosestCorrectDate (allEvents, index, convertedStartDate) {
  if (new Date(allEvents[index].Timestamp) < convertedStartDate) {
    return findClosestCorrectDate(allEvents, index + 1, convertedStartDate);
  }

  return new Date(allEvents[index].Timestamp);
}

// TODO SonarLint: Refactor this function to reduce its Cognitive Complexity from 68 to the 15 allowed.
(async function processing () {
  const events = fs.readdirSync(MEETING_EVENTS_PATH);

  const { allEvents, mainStart, mainEnd } = convertAllEvents(events.map(v => `${MEETING_EVENTS_PATH}/${v}`));

  const userNamesMap = await fetchUsersData(mainStart);

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

    for (const event of allEvents) {
      // generate subtitle when user is not sharing screen
      if (event.EventType === ActiveSpeaker && !sharingScreen) {
        attendeeId = event.EventParameters.AttendeeId;
        const diff = new Date(event.Timestamp) - new Date(mainStart);
        const text = userNamesMap.get(attendeeId)
          ? `${userNamesMap.get(attendeeId)} talking`
          : "";

        if (list.length === 0) {
          list.push({
            type: "cue",
            data: {
              start: diff,
              text,
              settings: ""
            }
          });
        } else {
          list[list.length - 1].data.end = diff;
          list.push({
            type: "cue",
            data: {
              start: diff,
              text,
              settings: ""
            }
          });
        }
      }

      // generate subtitle when user is sharing screen
      if (event.EventType === ActiveSpeaker && sharingScreen) {
        attendeeId = event.EventParameters.AttendeeId;
        const diff = new Date(event.Timestamp) - new Date(mainStart);
        const text = userNamesMap.get(attendeeId)
          ? `${userNamesMap.get(attendeeId)}`
          : "";

        if (list.length === 0) {
          list.push({
            type: "cue",
            data: {
              start: diff,
              text,
              settings: "X1:600 X2:625 Y1:100 Y2:100"
            }
          });
        } else {
          list[list.length - 1].data.end = diff;
          list.push({
            type: "cue",
            data: {
              start: diff,
              text,
              settings: "X1:600 X2:625 Y1:100 Y2:100"
            }
          });
        }
      }

      // processing screen sharing
      if (event.EventType === AttendeeVideoJoined && event.EventParameters) {
        if (event.EventParameters.MediaModality === ContentShare) {
          startBuff = event.Timestamp;
          sharingScreen = true;

          let pathToFile;
          if (isStart) {
            pathToFile = await writeToFile(
              `${MEETING_RECORDING_PATH}/${index}.txt`, AUDIO_PATH,
              new Date(mainStart),
              new Date(startBuff)
            );
            isStart = false;
          } else {
            pathToFile = await writeToFile(
              `${MEETING_RECORDING_PATH}/${index}.txt`, AUDIO_PATH,
              new Date(endBuff),
              new Date(startBuff)
            );
          }
          pathToFile && contentPaths.push({
            pathToFile,
            index
          });
        }
      }

      // precessing
      if (event.EventType === AttendeeVideoLeft && event.EventParameters && event.EventParameters.MediaModality === ContentShare) {
        endBuff = event.Timestamp;

        sharingScreen = false;

        if (new Date(endBuff) < convertedStartDate) {
          endBuff = findClosestCorrectDate(allEvents, index, convertedStartDate);
        }

        const [pathToFileAudio, pathToFileVideo] = await Promise.all([
          writeToFile(`${MEETING_RECORDING_PATH}/${index}-audio.txt`,
            AUDIO_PATH,
            new Date(startBuff),
            new Date(endBuff)
          ),
          writeToFile(`${MEETING_RECORDING_PATH}/${index}-video.txt`,
            VIDEO_PATH,
            new Date(startBuff),
            new Date(endBuff)
          )
        ]);

        contentPaths.push({
          type: "concat",
          index,
          video: {
            pathToFile: pathToFileVideo
          },
          audio: {
            pathToFile: pathToFileAudio
          }
        });
      }

      if (index === allEvents.length - 1) {
        const pathToFile = await writeToFile(
          `${MEETING_RECORDING_PATH}/${index}.txt`, AUDIO_PATH,
          new Date(endBuff),
          new Date(mainEnd)
        );

        pathToFile && contentPaths.push({
          pathToFile,
          index
        });
      }
      index += 1;
    }

    if (list.length) {
      list[list.length - 1].data.end = endMilliseconds;
    }

    // Adding delays to subtitles
    let prevIndex = 1;
    list.forEach((item, i) => {
      if (i > 0) {
        if (list[i - prevIndex].data.settings !== item.data.settings) {
          const end = list[i - prevIndex].data.end;
          const start = item.data.start;

          if (start - end > 1000) return;

          list[i - prevIndex].data.end = prevIndex > 1
            ? end
            : end - 200;
          item.data.start = prevIndex > 1 ? end + 1000 : start + 800;

          const newStart = item.data.start;

          if (newStart > item.data.end) {
            delete list[i];
            prevIndex += 1;
          } else {
            prevIndex = 1;
          }
        }
      }
    });

    // Generating subtitles
    fs.writeFileSync(SRT_PATH, stringifySync(list.filter(Boolean), { format: "SRT" }));

    const ffmpegInputFilePointer = fs.createWriteStream(FFMPEG_FILE_LIST_INPUT);
    ffmpegInputFilePointer.on("error", function (err) {
      console.error("An error occurred", err);
    });
    const resultFileEnd = util.promisify(ffmpegInputFilePointer.end)
      .bind(ffmpegInputFilePointer);

    for (const item of contentPaths) {
      let newPath;

      if (item.type) {
        const [audioPath, videoPath] = await Promise.all([
          concatContentChunks(item.audio.pathToFile, `audio-${item.index}`),
          concatContentChunks(item.video.pathToFile, `video-${item.index}`)
        ]);
        newPath = await concatAudioAndVideo(audioPath, videoPath, item.index);
      } else {
        newPath = await concatContentChunks(item.pathToFile, item.index);
      }

      ffmpegInputFilePointer.write(`file '${newPath}'` + "\n");

      item.pathToFile = newPath;
    }

    await resultFileEnd();
  } catch (err) {
    throw new Error(err);
  }
})()
  .then(() => console.log("Process finished."))
  .catch(err => console.error("Process failed.", err));

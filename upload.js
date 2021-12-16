const AWS = require("aws-sdk");
const { argv } = require("process");
const fs = require("fs");

const FILE_PATH = argv[2];
const BUCKET = process.env.BUCKET;;
const SESSION_ID = process.env.SESSION_ID;
const MEETING_ID = process.env.MEETING_ID;

async function uploadToS3 (fileName, filePath) {
  if (!fileName) {
    throw new Error("the fileName is empty");
  }
  if (!filePath) {
    throw new Error("the file absolute path is empty");
  }

  const fileNameInS3 = `${fileName}`; // the relative path inside the bucket
  console.info(`file name: ${fileNameInS3} file path: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`file does not exist: ${filePath}`);
  }

  const bucket = `${BUCKET}/output/${SESSION_ID}`;

  const s3 = new AWS.S3();

  const statsFile = fs.statSync(filePath);
  console.info(`file size: ${Math.round(statsFile.size / 1024 / 1024)}MB`);

  //  Each part must be at least 5 MB in size, except the last part.
  let uploadId;
  try {
    const params = {
      Bucket: bucket,
      Key: fileNameInS3
    };
    const result = await s3.createMultipartUpload(params).promise();
    uploadId = result.UploadId;
    console.info(`csv ${fileNameInS3} multipart created with upload id: ${uploadId}`);
  } catch (e) {
    throw new Error(`Error creating S3 multipart. ${e.message}`);
  }

  const chunkSize = 10 * 1024 * 1024; // 10MB
  const readStream = fs.createReadStream(filePath); // you can use a second parameter here with this option to read with a bigger chunk size than 64 KB: { highWaterMark: chunkSize }

  // read the file to upload using streams and upload part by part to S3
  const uploadPartsPromise = new Promise((resolve, reject) => {
    const multipartMap = { Parts: [] };

    let partNumber = 1;
    let chunkAccumulator = null;

    readStream.on("error", (err) => {
      reject(err);
    });

    readStream.on("data", (chunk) => {
      // it reads in chunks of 64KB. We accumulate them up to 10MB and then we send to S3
      if (chunkAccumulator === null) {
        chunkAccumulator = chunk;
      } else {
        chunkAccumulator = Buffer.concat([chunkAccumulator, chunk]);
      }
      if (chunkAccumulator.length > chunkSize) {
        // pause the stream to upload this chunk to S3
        readStream.pause();

        const chunkMB = chunkAccumulator.length / 1024 / 1024;

        const params = {
          Bucket: bucket,
          Key: fileNameInS3,
          PartNumber: partNumber,
          UploadId: uploadId,
          Body: chunkAccumulator,
          ContentLength: chunkAccumulator.length
        };
        s3.uploadPart(params).promise()
          .then((result) => {
            console.info(`Data uploaded. Entity tag: ${result.ETag} Part: ${params.PartNumber} Size: ${chunkMB}`);
            multipartMap.Parts.push({ ETag: result.ETag, PartNumber: params.PartNumber });
            partNumber++;
            chunkAccumulator = null;
            // resume to read the next chunk
            readStream.resume();
          }).catch((err) => {
            console.error(`error uploading the chunk to S3 ${err.message}`);
            reject(err);
          });
      }
    });

    readStream.on("end", () => {
      console.info("End of the stream");
    });

    readStream.on("close", () => {
      console.info("Close stream");
      if (chunkAccumulator) {
        const chunkMB = chunkAccumulator.length / 1024 / 1024;

        // upload the last chunk
        const params = {
          Bucket: bucket,
          Key: fileNameInS3,
          PartNumber: partNumber,
          UploadId: uploadId,
          Body: chunkAccumulator,
          ContentLength: chunkAccumulator.length
        };

        s3.uploadPart(params).promise()
          .then((result) => {
            console.info(`Last Data uploaded. Entity tag: ${result.ETag} Part: ${params.PartNumber} Size: ${chunkMB}`);
            multipartMap.Parts.push({ ETag: result.ETag, PartNumber: params.PartNumber });
            chunkAccumulator = null;
            resolve(multipartMap);
          }).catch((err) => {
            console.error(`error uploading the last csv chunk to S3 ${err.message}`);
            reject(err);
          });
      }
    });
  });

  const multipartMap = await uploadPartsPromise;

  console.info(`All parts have been upload. Let's complete the multipart upload. Parts: ${multipartMap.Parts.length} `);

  // gather all parts' tags and complete the upload
  try {
    const params = {
      Bucket: bucket,
      Key: fileNameInS3,
      MultipartUpload: multipartMap,
      UploadId: uploadId
    };
    const result = await s3.completeMultipartUpload(params).promise();
    console.info(`Upload multipart completed. Location: ${result.Location} Entity tag: ${result.ETag}`);
  } catch (e) {
    throw new Error(`Error completing S3 multipart. ${e.message}`);
  }

  return fileNameInS3;
}

uploadToS3(`${MEETING_ID}.mp4`, FILE_PATH);

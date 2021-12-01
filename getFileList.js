const AWS = require("aws-sdk");
const fs = require("fs");
const { argv } = require("process");

const S3 = new AWS.S3({ region: process.env.AWS_REGION, signatureVersion: "v4" });
const BUCKET = process.env.BUCKET;
const MEETING_ID = process.env.MEETING_ID;

(async () => {
  const FOLDER = argv[2];
  const audioBucketParams = {
    Bucket: BUCKET,
    Prefix: `captures/${MEETING_ID}/${FOLDER}`,
    Marker: ""
  };

  const DIR = `/tmp/${MEETING_ID}/${FOLDER}`;

  try {
    fs.mkdirSync(DIR, { recursive: true });
    let i = 1;
    while (i === 1 || audioBucketParams.Marker) {
      const bucketList = await S3.listObjects(audioBucketParams).promise();
      for (const object in bucketList.Contents) {
        const url = await S3.getSignedUrlPromise("getObject", {
          Bucket: BUCKET,
          Key: bucketList.Contents[object].Key,
          Expires: 60 * 60 * 24
        });
        console.log(url);
        fs.appendFileSync(`${DIR}-files.txt`, `${url}\n`);
      }
      if (bucketList.IsTruncated) audioBucketParams.Marker = bucketList.NextMarker;
      i = i + 1;
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  process.exit(0);
})();

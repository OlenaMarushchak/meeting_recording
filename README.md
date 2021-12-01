# Video Room Recording Processing

## Build Docker container

```shell
docker build . -t <tag>
```

## Run Docker container

Please make sure to provide the following environment variables:
- SESSION_ID (breakout session id)
- MEETING_ID (Chime meeting id)
- BUCKET (S3 Bucket name)
- EVENTS_TABLE_NAME (DynamoDB breakout session events table name)
- AWS_REGION (AWS Region)
- AWS_ACCESS_KEY_ID (mandatory if you run it locally)
- AWS_SECRET_ACCESS_KEY (mandatory if you run it locally)

```shell
docker run -ti \
 -e SESSION_ID='<breakout-session-id>' \
 -e MEETING_ID='<meeting-id>' \
 -e BUCKET='<stage>-video-breakout-room-recording' \
 -e EVENTS_TABLE_NAME='<stage>-breakout-session-events' \
 -e AWS_REGION='<aws-region>' \
 -e AWS_ACCESS_KEY_ID='<your-access-key>' \
 -e AWS_SECRET_ACCESS_KEY='<your-secret-key>' \
 --rm <tag>
```

If you want to see the output of the generated content you have to mount a volume
(e.g /output folder in the current directory). 
```shell
docker run -ti -v${PWD}/output:/tmp/<meeting-id> \
 -e SESSION_ID='<breakout-session-id>' \
 -e MEETING_ID='<meeting-id>' \
 -e BUCKET='<stage>-video-breakout-room-recording' \
 -e EVENTS_TABLE_NAME='<stage>-breakout-session-events' \
 -e AWS_REGION='<aws-region>' \
 -e AWS_ACCESS_KEY_ID='<your-access-key>' \
 -e AWS_SECRET_ACCESS_KEY='<your-secret-key>' \
 --rm <tag>
```

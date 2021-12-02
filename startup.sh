#!/bin/bash

set -euxo pipefail

# Downloads files concurrently utilizing as many procs as possible
downloadFiles() {
  cat $1 | xargs -P 0 -I{} wget --content-disposition {} -P $2
}

# Splits query parameters from the filename (since we're uploading files using pre-signed URL)
detachQueryString () {
  for i in `find $1 -type f -name "*\?*"`
  do
    mv $i `echo $i | cut -d? -f1`
  done
}

# File processing
processFiles() {
  if [ -f $1 ]
    then
      downloadFiles $1 $2
      detachQueryString $2
    else
      echo $1 not exist
  fi
}

echo "-----------------------------------------"
echo "Meeting Recording Processing Script"
echo "Version: 1.0.0"
echo "Current NodeJS Version: $(node --version)"
echo "-----------------------------------------"

echo "Processing Meeting: $MEETING_ID from $BUCKET and $SESSION_ID"
echo "AWS Region: $AWS_REGION"
echo "AWS DynamoDB Events table: $EVENTS_TABLE_NAME"

BUCKET=$BUCKET
MEETING_ID=$MEETING_ID

path=/tmp/$MEETING_ID
ffmpeg_srt_path=$path/sub.srt
ffmpeg_file_list_input=$path/ffmpeg-input.txt
result_filepath_no_subtitles=$path/$MEETING_ID-no-sub.mp4
result_filepath_with_subtitles=$path/$MEETING_ID.mp4
concurrently=/home/node_modules/.bin/concurrently
get_file_list=/home/getFileList.js
processor=/home/processor.js
upload=/home/upload.js
audio_path=$path/audio
video_path=$path/video
events_path=$path/meeting-events

mkdir -p $path

################################################
echo "-----------------------------------------"
echo "START: Listing S3 object(s)..."
  node $concurrently --raw "node $get_file_list audio" \
    "node $get_file_list video" \
    "node $get_file_list meeting-events"
echo "END: Listing S3 object(s)"
echo "-----------------------------------------"
################################################
echo "-----------------------------------------"
echo "START: Downloading audio/video/meeting-events..."
  processFiles $path/audio-files.txt $audio_path && processFiles $path/video-files.txt $video_path && processFiles $path/meeting-events-files.txt $events_path
echo "END: Downloading"
echo "-----------------------------------------"
################################################
echo "-----------------------------------------"
echo "START: Processing files..."
  node $processor
echo "END: Processing"
echo "-----------------------------------------"
################################################
echo "-----------------------------------------"
echo "START: Assembling files..."
  ffmpeg -f concat -safe 0 -i $ffmpeg_file_list_input -c copy $result_filepath_no_subtitles
echo "END: Assembling"
echo "-----------------------------------------"
################################################
echo "-----------------------------------------"
echo "START: Adding subtitles..."
  ffmpeg -i $result_filepath_no_subtitles -vf subtitles=$ffmpeg_srt_path:force_style='Fontsize=10' $result_filepath_with_subtitles
echo "END: Adding subtitles"
echo "-----------------------------------------"
################################################
echo "-----------------------------------------"
echo "START: Uploading the output to S3..."
  node $upload $result_filepath_with_subtitles
echo "END: Uploading the output to S3"
echo "-----------------------------------------"

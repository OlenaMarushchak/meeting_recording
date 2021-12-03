FROM jrottenberg/ffmpeg:4.4-alpine

ENTRYPOINT ["/bin/bash"]

RUN apk --no-cache add bash wget && \
    apk --no-cache add --update nodejs npm && \
    apk --no-cache add py-pip && \
    apk --update add fontconfig ttf-dejavu && \
    pip install awscli

COPY ./startup.sh /home/startup.sh
COPY ./getFileList.js /home/getFileList.js
COPY ./processor.js /home/processor.js
COPY ./upload.js /home/upload.js
COPY ./package.json /home/package.json
COPY ./package-lock.json /home/package-lock.json

WORKDIR /home

RUN npm ci

CMD ["/home/startup.sh"]

#!/bin/bash

echo "Please enter the name of file or dir to add to git"
read name

git add $name

echo "Please enter the message you would like when committing"
read message

git commit -m "$message"

git push https://github.com/the-linux-schools-project/karoshi-client.git pheonix

#!/usr/bin/env bash
set -euo pipefail

if [ "$(basename "$PWD")" != "conductor" ]; then
	echo "This script must be run from the conductor root directory"
	exit 1
fi

if [ ! -d ./build/Products/Debug-iphonesimulator/conductor-driver-iosUITests-Runner.app ]; then
  echo "XCTest runner app not found in ./build/Products/Debug-iphonesimulator/conductor-driver-iosUITests-Runner.app"
  exit 1
fi

if [ ! -d ./build/Products/Debug-iphonesimulator/conductor-driver-ios.app ]; then
  echo "Dummy test app not found in ./build/Products/Debug-iphonesimulator/conductor-driver-ios.app"
  exit 1
fi

if [ -z "$(ls ./build/Products/*.xctestrun 2>/dev/null)" ]; then
  echo "xctestrun file not found in ./build/Products/"
  exit 1
fi

echo "Will run the XCTest runner in the background and redirect its output"
mkfifo pipe
trap 'rm -f pipe' EXIT

while IFS= read -r line; do
	  printf "==> XCTestRunner: %s\n" "$line"
done < pipe &

./conductor-ios-xctest-runner/run-conductor-ios-runner.sh 1>pipe 2>&1 &
echo "XCTest runner started in background, PID: $!"

sleep 5

request_successful=false
while [ "$request_successful" = false ]; do
  echo "Will curl the /deviceInfo endpoint to check if the XCTest runner is ready"
  if ! test_upload_response="$(curl --fail-with-body -sS -X GET "http://localhost:1075/deviceInfo")"; then
	  echo "Error: failed to GET /deviceInfo endpoint"
	  echo "$test_upload_response"
	  echo "Will wait 5 seconds and try again"
	  sleep 5
	else
	    request_successful=true
	    echo "GET /deviceInfo endpoint successful"
  fi
done

.PHONY: build build-cli build-ios-driver build-android-driver package-cli

ANDROID_OUT    = packages/android-driver/conductor-android/build/outputs/apk
CLI_DRIVERS    = packages/cli/drivers
IOS_DERIVED    = packages/ios-driver/derived-data
IOS_BUILD_PRODUCTS = $(IOS_DERIVED)/Build/Products/Debug-iphonesimulator

build: build-ios-driver build-android-driver package-cli build-cli

build-cli:
	cd packages/cli && pnpm build

build-ios-driver:
	xcodebuild build-for-testing \
		-project packages/ios-driver/conductor-driver-ios.xcodeproj \
		-scheme conductor-driver-ios \
		-destination "generic/platform=iOS Simulator" \
		-derivedDataPath $(CURDIR)/$(IOS_DERIVED)

build-android-driver:
	cd packages/android-driver && ./gradlew :conductor-android:assembleDebug :conductor-android:assembleAndroidTest

package-cli: build-ios-driver build-android-driver
	mkdir -p $(CLI_DRIVERS)/android $(CLI_DRIVERS)/ios
	cp $(ANDROID_OUT)/debug/conductor-android-debug.apk \
		$(CLI_DRIVERS)/android/conductor-app.apk
	cp $(ANDROID_OUT)/androidTest/debug/conductor-android-debug-androidTest.apk \
		$(CLI_DRIVERS)/android/conductor-server.apk
	cd $(IOS_BUILD_PRODUCTS) && zip -qr $(CURDIR)/$(CLI_DRIVERS)/ios/conductor-driver-ios.zip conductor-driver-ios.app
	cd $(IOS_BUILD_PRODUCTS) && zip -qr $(CURDIR)/$(CLI_DRIVERS)/ios/conductor-driver-iosUITests-Runner.zip conductor-driver-iosUITests-Runner.app
	cp $$(find $(IOS_DERIVED)/Build/Products -name "*.xctestrun" | head -1) \
		$(CLI_DRIVERS)/ios/conductor-driver-ios-config.xctestrun

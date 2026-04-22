.PHONY: build build-cli build-ios-driver build-tvos-driver build-android-driver package-cli package-drivers-tarball

DRIVERS_TARBALL_DIR = dist-drivers

ANDROID_OUT    = packages/android-driver/conductor-android/build/outputs/apk
CLI_DRIVERS    = packages/cli/drivers
IOS_DERIVED    = packages/ios-driver/derived-data
IOS_BUILD_PRODUCTS = $(IOS_DERIVED)/Build/Products/Debug-iphonesimulator
TVOS_DERIVED   = packages/ios-driver/derived-data-tvos
TVOS_BUILD_PRODUCTS = $(TVOS_DERIVED)/Build/Products/Debug-appletvsimulator

build: build-ios-driver build-tvos-driver build-android-driver package-cli build-cli

build-cli:
	cd packages/cli && pnpm build

build-ios-driver:
	xcodebuild build-for-testing \
		-project packages/ios-driver/conductor-driver-ios.xcodeproj \
		-scheme conductor-driver-ios \
		-destination "generic/platform=iOS Simulator" \
		-derivedDataPath $(CURDIR)/$(IOS_DERIVED)

build-tvos-driver:
	xcodebuild build-for-testing \
		-project packages/ios-driver/conductor-driver-ios.xcodeproj \
		-scheme conductor-driver-tvos \
		-destination "generic/platform=tvOS Simulator" \
		-derivedDataPath $(CURDIR)/$(TVOS_DERIVED)

build-android-driver:
	cd packages/android-driver && ./gradlew :conductor-android:assembleDebug :conductor-android:assembleAndroidTest

package-cli: build-ios-driver build-tvos-driver build-android-driver
	mkdir -p $(CLI_DRIVERS)/android $(CLI_DRIVERS)/ios $(CLI_DRIVERS)/tvos
	cp $(ANDROID_OUT)/debug/conductor-android-debug.apk \
		$(CLI_DRIVERS)/android/conductor-app.apk
	cp $(ANDROID_OUT)/androidTest/debug/conductor-android-debug-androidTest.apk \
		$(CLI_DRIVERS)/android/conductor-server.apk
	cd $(IOS_BUILD_PRODUCTS) && zip -qr $(CURDIR)/$(CLI_DRIVERS)/ios/conductor-driver-ios.zip conductor-driver-ios.app
	cd $(IOS_BUILD_PRODUCTS) && zip -qr $(CURDIR)/$(CLI_DRIVERS)/ios/conductor-driver-iosUITests-Runner.zip conductor-driver-iosUITests-Runner.app
	cp $$(find $(IOS_DERIVED)/Build/Products -name "*.xctestrun" | head -1) \
		$(CLI_DRIVERS)/ios/conductor-driver-ios-config.xctestrun
	cd $(TVOS_BUILD_PRODUCTS) && zip -qr $(CURDIR)/$(CLI_DRIVERS)/tvos/conductor-driver-tvos.zip conductor-driver-tvos.app
	cd $(TVOS_BUILD_PRODUCTS) && zip -qr $(CURDIR)/$(CLI_DRIVERS)/tvos/conductor-driver-tvosUITests-Runner.zip conductor-driver-tvosUITests-Runner.app
	cp $$(find $(TVOS_DERIVED)/Build/Products -name "*.xctestrun" | head -1) \
		$(CLI_DRIVERS)/tvos/conductor-driver-tvos-config.xctestrun

package-drivers-tarball:
	mkdir -p $(DRIVERS_TARBALL_DIR)
	cd $(CLI_DRIVERS) && tar -czf $(CURDIR)/$(DRIVERS_TARBALL_DIR)/drivers.tar.gz android ios tvos

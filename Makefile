.PHONY: build build-cli build-ios-driver build-ios-inproc build-ios-capture build-tvos-driver build-android-driver package-cli package-driver-sources package-drivers-tarball

DRIVERS_TARBALL_DIR = dist-drivers

ANDROID_OUT    = packages/android-driver/conductor-android/build/outputs/apk
CLI_DRIVERS    = packages/cli/drivers
IOS_DERIVED    = packages/ios-driver/derived-data
IOS_BUILD_PRODUCTS = $(IOS_DERIVED)/Build/Products/Debug-iphonesimulator
TVOS_DERIVED   = packages/ios-driver/derived-data-tvos
TVOS_BUILD_PRODUCTS = $(TVOS_DERIVED)/Build/Products/Debug-appletvsimulator

build: build-ios-driver build-ios-inproc build-ios-capture build-tvos-driver build-android-driver package-cli build-cli

build-cli:
	cd packages/cli && pnpm build

# Injectable in-process control library → $(CLI_DRIVERS)/ios-inproc/Conductor.framework
build-ios-inproc:
	packages/ios-inproc/tools/build-inproc-dylib.sh

# Host-side Simulator video capture binary → $(CLI_DRIVERS)/ios-capture/conductor-capture
build-ios-capture:
	packages/ios-capture/tools/build-capture.sh

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

package-cli: build-ios-driver build-ios-inproc build-tvos-driver build-android-driver package-driver-sources
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

# Driver sources for physical devices. Real hardware only runs code signed for
# the user's team, so the driver is compiled locally on first use rather than
# shipped prebuilt like the simulator slices.
IOS_DRIVER_SRC = $(CLI_DRIVERS)/ios-driver-src
package-driver-sources:
	rm -rf $(IOS_DRIVER_SRC)
	mkdir -p $(IOS_DRIVER_SRC)
	cd packages/ios-driver && tar -cf - \
		--exclude derived-data --exclude derived-data-tvos --exclude .DS_Store \
		--exclude .build --exclude xcuserdata \
		conductor-driver-ios.xcodeproj conductor-driver-ios conductor-driver-iosUITests \
		conductor-driver-iosTests ConductorDriverLib packages \
		| tar -xf - -C $(CURDIR)/$(IOS_DRIVER_SRC)

package-drivers-tarball: package-driver-sources
	mkdir -p $(DRIVERS_TARBALL_DIR)
	cd $(CLI_DRIVERS) && tar -czf $(CURDIR)/$(DRIVERS_TARBALL_DIR)/drivers.tar.gz android ios ios-inproc ios-capture tvos ios-driver-src

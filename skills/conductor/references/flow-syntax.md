# Conductor Flow Syntax Reference

Conductor flows are YAML files that describe sequences of mobile UI actions.

## Basic Structure

```yaml
appId: com.example.myapp
---
- launchApp
- tapOn: "Sign In"
- inputText: "user@example.com"
- takeScreenshot: /tmp/after-login
```

## Common Commands

### App Control

```yaml
- launchApp
- launchApp:
    appId: com.other.app   # launch a different app
- stopApp
- stopApp:
    appId: com.other.app
- clearState               # clear app data
- clearKeychain            # clear keychain (iOS: full keychain; Android: account credentials)
```

### Tapping

```yaml
- tapOn: "Button Text"        # by text
- tapOn:
    id: "button_id"           # by accessibility ID
- tapOn:
    text: "Submit"
    index: 1                  # second match
- longPressOn: "Element"
- doubleTapOn: "Element"
```

### Text Input

```yaml
- inputText: "hello world"
- eraseText                   # erase 50 characters from focused field
- eraseText:
    charactersToErase: 10     # erase specific number of characters
- pressKey: Enter
- pressKey: Backspace
- pressKey: Home
- pressKey: Remote Dpad Down  # Android TV only; also Up, Left, Right, Center, Remote Media Play Pause, Remote Media Stop, Remote Media Next, Remote Media Previous, Remote Media Rewind, Remote Media Fast Forward, Remote System Navigation Up, Remote System Navigation Down, Remote Button A, Remote Button B, Remote Menu, TV Input, TV Input HDMI 1/2/3
- pasteText: "pasted content" # paste text into focused field
- copyTextFrom: "Element"     # copy element's text to output.textContent
```

### Scrolling & Swiping

```yaml
- scroll                      # scroll down
- scrollUntilVisible:
    element:
      text: "Target"
- swipe:
    direction: UP             # UP | DOWN | LEFT | RIGHT
- swipe:
    start: { x: 50%, y: 80% }
    end: { x: 50%, y: 20% }
```

### Navigation

```yaml
- back                        # Android back button
- hideKeyboard
- openLink: "myapp://screen"  # deep link
```

### Assertions

```yaml
- assertVisible: "Welcome"
- assertVisible:
    text: "Welcome"
    enabled: true
- assertNotVisible: "Error"
- assertTrue:
    condition: "${count} > 0"
- assertFalse:
    condition: "${error} == true"
```

### Waiting

```yaml
- waitForAnimationToEnd
- extendedWaitUntil:
    visible:
      text: "Loading complete"
    timeout: 5000
```

### Screenshots & Recording

```yaml
- takeScreenshot: /tmp/my-screenshot    # saves as /tmp/my-screenshot.png
- startRecording: /tmp/recording.mp4    # start screen recording
- stopRecording                         # stop screen recording
```

### Variables & Conditions

```yaml
- evalScript: ${MY_VAR = "hello"}
- runScript:
    file: ./setup.js               # run a JS file; output object is merged into flow env
- runFlow:
    file: ./other-flow.yaml
    env:
      USERNAME: "testuser"
- runFlow:
    when:
      visible: "Login"
    file: ./login.yaml
```

### Repeat & Retry

```yaml
- repeat:
    times: 3
    commands:
      - tapOn: "Retry"
- repeat:
    while:
      notVisible: "Done"
    commands:
      - scroll
- retry:
    maxRetries: 2
    commands:
      - tapOn: "Submit"
      - assertVisible: "Success"
```

### Device & Permissions

```yaml
- setPermissions:
    com.example.myapp:
      notifications: allow
      camera: deny
      all: allow             # grant all permissions at once
- setLocation:
    latitude: 52.3676
    longitude: 4.9041
- setOrientation: landscape  # portrait | landscape
```

## Environment Variables

Pass values from the environment:

```yaml
appId: ${APP_ID}
---
- inputText: ${USERNAME}
```

Run with: `conductor run-flow flow.yaml -e APP_ID=com.example -e USERNAME=test`

## Tips for AI Agents

- Use `conductor inspect` to find element text/IDs before tapping
- Use `assertVisible` to confirm navigation succeeded
- Use `takeScreenshot` after key actions for verification
- Use `scrollUntilVisible` to reach off-screen elements
- IDs are more stable than text labels for long-lived tests

// main.swift — newline-delimited JSON-over-stdio loop. One request per line,
// one response per line, stdout flushed after each. conductor's daemon spawns
// this host binary and streams pointer frames for live drags (see
// src/drivers/ios-hid.ts).
//
// Requests:
//   {"cmd":"ping"}
//   {"cmd":"touch","udid":"<UDID>","x":0.5,"y":0.5,"type":0|1|2}   // 0=down 1=move 2=up
//   {"cmd":"keyboard","udid":"<UDID>","keyCode":36,"modifierFlags":0,"isDown":true}
//   {"cmd":"button","udid":"<UDID>","keyCode":1,"op":1,"target":51}
// Responses: {"ok":true,"rc":0}  or  {"ok":false,"error":"..."}
import Foundation

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func handle(_ req: [String: Any]) {
    let cmd = req["cmd"] as? String ?? ""
    switch cmd {
    case "ping":
        emit(["ok": true])
    case "touch":
        guard let udid = req["udid"] as? String,
              let x = (req["x"] as? NSNumber)?.floatValue,
              let y = (req["y"] as? NSNumber)?.floatValue,
              let type = (req["type"] as? NSNumber)?.int32Value else {
            emit(["ok": false, "error": "touch requires udid,x,y,type"]); return
        }
        let rc = hidTouch(udid: udid, normX: x, normY: y, eventType: type)
        emit(["ok": rc == 0, "rc": Int(rc)])
    case "keyboard":
        guard let udid = req["udid"] as? String,
              let keyCode = (req["keyCode"] as? NSNumber)?.uint16Value else {
            emit(["ok": false, "error": "keyboard requires udid,keyCode"]); return
        }
        let mods = (req["modifierFlags"] as? NSNumber)?.uint64Value ?? 0
        let isDown = (req["isDown"] as? NSNumber)?.boolValue ?? true
        let rc = hidKeyboard(udid: udid, keyCode: keyCode, modifierFlags: mods, isDown: isDown)
        emit(["ok": rc == 0, "rc": Int(rc)])
    case "button":
        guard let udid = req["udid"] as? String,
              let keyCode = (req["keyCode"] as? NSNumber)?.uint32Value else {
            emit(["ok": false, "error": "button requires udid,keyCode"]); return
        }
        let op = (req["op"] as? NSNumber)?.uint32Value ?? 1
        let target = (req["target"] as? NSNumber)?.uint32Value ?? 51
        let rc = hidButton(udid: udid, keyCode: keyCode, op: op, target: target)
        emit(["ok": rc == 0, "rc": Int(rc)])
    default:
        emit(["ok": false, "error": "unknown cmd: \(cmd)"])
    }
}

// SIGPIPE would kill us if the daemon closes stdout mid-write — ignore it.
signal(SIGPIPE, SIG_IGN)

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        emit(["ok": false, "error": "malformed json"])
        continue
    }
    handle(obj)
}

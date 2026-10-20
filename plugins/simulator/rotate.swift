// Rotates one booted simulator: sends the GSEvent device-orientation message (type 50) to its PurpleWorkspacePort,
// as Simulator.app's rotate menu and facebook/idb's SimulatorPurpleHID do. Headless; touches no other simulator.
// Usage: rotate <udid> portrait|portrait-upside-down|landscape-left|landscape-right
import Foundation
import ObjectiveC

func fail(_ text: String) -> Never { FileHandle.standardError.write(Data((text + "\n").utf8)); exit(1) }
let arguments = CommandLine.arguments
let orientations: [String: UInt32] = ["portrait": 1, "portrait-upside-down": 2, "landscape-left": 3, "landscape-right": 4]
guard arguments.count == 3, let udid = UUID(uuidString: arguments[1]), let orientation = orientations[arguments[2]] else {
  fail("usage: rotate <udid> portrait|portrait-upside-down|landscape-left|landscape-right")
}

func developerDir() -> String {
  if let dir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] { return dir }
  let pipe = Pipe(), process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
  process.arguments = ["-p"]
  process.standardOutput = pipe
  do { try process.run() } catch { fail("xcode-select failed: \(error)") }
  process.waitUntilExit()
  return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Private CoreSimulator methods, called through their implementations because there are no public headers.
func implementation<T>(_ target: AnyObject, _ name: String, as _: T.Type) -> (T, Selector) {
  let selector = NSSelectorFromString(name)
  let method = target is AnyClass ? class_getClassMethod(target as? AnyClass, selector) : class_getInstanceMethod(type(of: target), selector)
  guard let method else { fail("CoreSimulator has no \(name)") }
  return (unsafeBitCast(method_getImplementation(method), to: T.self), selector)
}
typealias ContextFunction = @convention(c) (AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
typealias DeviceSetFunction = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
typealias LookupFunction = @convention(c) (AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> mach_port_t

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil, let contextClass = NSClassFromString("SimServiceContext") else { fail("CoreSimulator is unavailable") }
var error: NSError?
let (makeContext, contextSelector) = implementation(contextClass, "sharedServiceContextForDeveloperDir:error:", as: ContextFunction.self)
guard let context = makeContext(contextClass, contextSelector, developerDir() as NSString, &error) else { fail("CoreSimulator context: \(error?.localizedDescription ?? "unavailable")") }
let (makeSet, setSelector) = implementation(context, "defaultDeviceSetWithError:", as: DeviceSetFunction.self)
guard let set = makeSet(context, setSelector, &error) as? NSObject else { fail("Default device set: \(error?.localizedDescription ?? "unavailable")") }
guard let device = (set.value(forKey: "devicesByUDID") as? [UUID: NSObject])?[udid] else { fail("No simulator \(udid.uuidString) in the default device set") }
// SimDeviceState 3 = Booted.
guard (device.value(forKey: "state") as? Int) == 3 else { fail("Simulator \(udid.uuidString) is not booted") }
let (lookup, lookupSelector) = implementation(device, "lookup:error:", as: LookupFunction.self)
let port = lookup(device, lookupSelector, "PurpleWorkspacePort", &error)
guard port != 0 else { fail("PurpleWorkspacePort: \(error?.localizedDescription ?? "unavailable")") }

// 108-byte mach message: header (bits COPY_SEND, size, remote port, id 0x7B), GSEvent type with the host flag,
// record info size 4 and the UIDeviceOrientation value. Layout: idb's SimulatorPurpleHID.
var message = [UInt8](repeating: 0, count: 112)
func put(_ value: UInt32, at offset: Int) { withUnsafeBytes(of: value.littleEndian) { message.replaceSubrange(offset..<offset + 4, with: $0) } }
put(0x13, at: 0x00); put(108, at: 0x04); put(port, at: 0x08); put(0x7B, at: 0x14)
put(50 | 0x2_0000, at: 0x18); put(4, at: 0x48); put(orientation, at: 0x4C)
let result = message.withUnsafeMutableBytes { raw in
  mach_msg(raw.baseAddress!.assumingMemoryBound(to: mach_msg_header_t.self), MACH_SEND_MSG | MACH_SEND_TIMEOUT, 108, 0, mach_port_t(MACH_PORT_NULL), 2000, mach_port_t(MACH_PORT_NULL))
}
guard result == KERN_SUCCESS else { fail("Orientation message failed: \(String(cString: mach_error_string(result)))") }
print("{\"udid\":\"\(udid.uuidString)\",\"orientation\":\"\(arguments[2])\"}")

// Local image recognition using macOS Vision. server.mjs compiles this helper with swiftc.
// Reads one path per stdin line and outputs one JSON record per image, with labels,
// a content fingerprint for similarity search, and average brightness for dark images.
// With --meta, reads GPS and capture date without decoding image pixels.
import CoreGraphics
import Foundation
import ImageIO
import Vision

let input = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
let paths = input.split(separator: "\n").map(String.init)
let lock = NSLock()
let thumbnailOptions = [
  kCGImageSourceCreateThumbnailFromImageAlways: true,
  kCGImageSourceThumbnailMaxPixelSize: 512,
  kCGImageSourceCreateThumbnailWithTransform: true,
] as CFDictionary

func brightness(of image: CGImage) -> Double {
  let size = 16
  var pixels = [UInt8](repeating: 0, count: size * size * 4)
  let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
    guard let context = CGContext(
      data: buffer.baseAddress, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    return true
  }
  if !drawn { return -1 }
  var total = 0.0
  for index in stride(from: 0, to: pixels.count, by: 4) {
    total += 0.299 * Double(pixels[index]) + 0.587 * Double(pixels[index + 1]) + 0.114 * Double(pixels[index + 2])
  }
  return (total / Double(size * size) / 255 * 100).rounded() / 100
}

func metadata(of path: String) -> [String: Any] {
  var out: [String: Any] = ["path": path]
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
  else {
    out["error"] = "could not open image"
    return out
  }
  if let gps = properties[kCGImagePropertyGPSDictionary] as? [CFString: Any],
    let latitude = gps[kCGImagePropertyGPSLatitude] as? Double,
    let longitude = gps[kCGImagePropertyGPSLongitude] as? Double,
    latitude != 0 || longitude != 0
  {
    let south = (gps[kCGImagePropertyGPSLatitudeRef] as? String) == "S"
    let west = (gps[kCGImagePropertyGPSLongitudeRef] as? String) == "W"
    out["geo"] = [south ? -latitude : latitude, west ? -longitude : longitude]
  }
  let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
  let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
  if let taken = (exif?[kCGImagePropertyExifDateTimeOriginal] ?? tiff?[kCGImagePropertyTIFFDateTime]) as? String {
    out["taken"] = taken
  }
  return out
}

let metaOnly = CommandLine.arguments.contains("--meta")

DispatchQueue.concurrentPerform(iterations: paths.count) { index in
  var out: [String: Any] = ["path": paths[index]]
  if metaOnly {
    out = metadata(of: paths[index])
  } else {
  autoreleasepool {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: paths[index]) as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions)
    else {
      out["error"] = "could not open image"
      return
    }
    let classify = VNClassifyImageRequest()
    let feature = VNGenerateImageFeaturePrintRequest()
    do {
      try VNImageRequestHandler(cgImage: image).perform([classify, feature])
      out["labels"] = (classify.results ?? [])
        .filter { $0.confidence >= 0.1 }
        .prefix(30)
        .map { [$0.identifier, Double(($0.confidence * 100).rounded() / 100)] as [Any] }
      if let print = feature.results?.first, print.elementType == .float {
        out["print"] = print.data.base64EncodedString()
      }
      out["brightness"] = brightness(of: image)
    } catch {
      out["error"] = error.localizedDescription
    }
  }
  }
  let data = (try? JSONSerialization.data(withJSONObject: out)) ?? Data("{}".utf8)
  lock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  lock.unlock()
}

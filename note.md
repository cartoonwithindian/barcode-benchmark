JavaScript / Web libraries
ZXing
@zxing/library
@zxing/browser
1D + 2D
Open source
html5-qrcode
1D + 2D
Camera support
Open source
Quagga2
1D
Excellent localization/rotation handling
Open source
QuaggaJS
Older version of Quagga2
1D
Open source
zbar-wasm
WebAssembly version of ZBar
1D + QR
Open source
@sec-ant/zbar-wasm
ZBar WebAssembly implementation
Open source
jsQR
QR only
Very lightweight
Open source
BarcodeDetector API
Browser-native
1D + 2D depending on browser/platform
No external library
Scandit Barcode Scanner SDK
1D + 2D
Very strong real-world scanning
Commercial
Dynamsoft Barcode Reader
1D + 2D
Excellent difficult-angle/damaged-barcode performance
Commercial
Anyline Barcode Scanner
1D + 2D
Commercial
STRICH
JavaScript barcode scanner
1D
Commercial
BarcodeAPI.org / Web Barcode Scanner libraries
Various browser implementations
Useful for comparison rather than necessarily production
🧠 Barcode decoding engines

These are worth testing if you're willing to build your own camera pipeline.

ZXing
ZXing-C++
ZBar
BoofCV
OpenCV
OpenCV.js
Dynamsoft Barcode Reader
Scandit
Google ML Kit Barcode Scanning
Apple Vision / VisionKit barcode detection
Google Code Scanner
Google ML Kit
📱 Android libraries / SDKs
Google ML Kit Barcode Scanning
Google Code Scanner
ZXing Android Embedded
ZXing Android
JourneyApps ZXing Android Embedded
Dynamsoft Barcode Reader Android SDK
Scandit Data Capture SDK
Anyline Barcode Scanner SDK
Microblink BlinkID / barcode capabilities
🍎 iOS
Apple Vision Framework
AVFoundation metadata barcode detection
Google ML Kit
Scandit
Dynamsoft
Anyline
Microblink
🖥️ Python

If you want to test individual images/video frames:

pyzbar
ZBar
OpenCV
OpenCV + pyzbar
ZXing-C++ Python bindings
Pyzxing
zxing-cpp
Dynamsoft Python SDK
BoofCV
🟢 Node.js
@zxing/library
@zxing/browser
zxing-cpp
@sec-ant/zbar-wasm
zbar.wasm
Quagga2
Dynamsoft Barcode Reader Node/JS SDK
🔵 .NET / C#

Since you're working with .NET/C#, these are especially worth testing:

ZXing.Net
ZXing.Net.Bindings.Windows.Compatibility
ZXing.Net.Maui
BarcodeLib
IronBarcode
Dynamsoft Barcode Reader SDK
Aspose.BarCode
Syncfusion Barcode
Spire.Barcode
Leadtools Barcode
Cognex DataMan SDK
🧪 Computer Vision / AI approaches

If your goal is extreme angles, blur, perspective, damaged labels, tiny barcodes, don't limit your experiment to barcode libraries.

You can test:

OpenCV
OpenCV.js
YOLO + barcode detection
YOLO + ZXing
YOLO + ZBar
YOLO + OpenCV
TensorFlow.js
MediaPipe
ONNX Runtime
PaddleOCR
PaddleOCR + barcode detector
EasyOCR + OpenCV
Tesseract OCR + OpenCV

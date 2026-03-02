export { createVisionProvider, VisionProvider } from './providers';
export { OllamaProvider, OpenAIProvider, AnthropicProvider, DisabledProvider } from './providers';

// OpenCV-based vision processor
export {
  segmentMessageStrips,
  refineBlockBoundaries,
  isImageRegion,
  isFileRegion,
  matchTemplate,
  findAllTemplateMatches,
  cropRegion,
  matToBase64,
  base64ToMat,
  loadImage,
  saveImage,
  resizeImage,
  preprocessForOCR,
  detectBlockType,
  processScreenshot,
  disposeImage,
  type MessageBlock,
  type SegmentResult,
  type TemplateMatchResult,
} from './opencvProcessor';

// Template manager
export { templateManager, type TemplateInfo } from './templateManager';

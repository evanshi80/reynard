export { createVisionProvider, VisionProvider } from './providers';
export { OllamaProvider, OpenAIProvider, AnthropicProvider, DisabledProvider } from './providers';

// Sharp-based vision processor (works with Node 22)
export {
  segmentMessageStrips,
  processScreenshot,
  cropBlock,
  resizeForVLM,
  imageToBase64,
  type MessageBlock as SharpMessageBlock,
  type SegmentResult as SharpSegmentResult,
} from './sharpProcessor';

// Template manager
export { templateManager, type TemplateInfo } from './templateManager';

// V2 Processor: Sharp + OCR + VLM pipeline
export {
  processScreenshotV2,
  detectBlockTypes,
  findAttachmentIcons,
  type V2Message,
  type V2ProcessResult,
} from './v2Processor';

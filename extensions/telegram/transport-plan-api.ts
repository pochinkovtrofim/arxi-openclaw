export {
  planTelegramCaption,
  planTelegramPhotoDocumentDelivery,
  type TelegramCaptionPlan,
  type TelegramPhotoDocumentDeliveryPlan,
} from "./src/telegram-runtime-planning.js";
export {
  planTelegramTextDeliveryPages,
  type TelegramTextDeliveryPage,
} from "./src/telegram-text-delivery.js";
export { TELEGRAM_EMPTY_CONTENT_ERROR_PATTERN } from "./src/rich-plain-fallback.js";
export { TELEGRAM_PHOTO_DOCUMENT_ERROR_PATTERN } from "./src/send-error-predicates.js";
export {
  describeReplyTarget,
  normalizeForwardedContext,
  type TelegramForwardedContext,
  type TelegramReplyTarget,
} from "./src/bot/helpers.js";

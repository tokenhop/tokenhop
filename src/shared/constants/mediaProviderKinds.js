// Media provider kinds — each kind maps to a route and endpoint config
/** Media route labels and endpoints shared by shell and provider pages. */
export const MEDIA_PROVIDER_KINDS = [
  {
    id: "embedding",
    label: "Embedding",
    icon: "data_array",
    endpoint: { method: "POST", path: "/v1/embeddings" },
  },
  {
    id: "image",
    label: "Text to image",
    icon: "brush",
    endpoint: { method: "POST", path: "/v1/images/generations" },
  },
  {
    id: "imageToText",
    label: "Image to text",
    icon: "image_search",
    endpoint: { method: "POST", path: "/v1/images/understanding" },
  },
  {
    id: "tts",
    label: "Text to speech",
    icon: "record_voice_over",
    endpoint: { method: "POST", path: "/v1/audio/speech" },
  },
  {
    id: "stt",
    label: "Speech to text",
    icon: "mic",
    endpoint: { method: "POST", path: "/v1/audio/transcriptions" },
  },
  {
    id: "webSearch",
    label: "Web search",
    icon: "travel_explore",
    endpoint: { method: "POST", path: "/v1/search" },
  },
  {
    id: "webFetch",
    label: "Web fetch",
    icon: "language",
    endpoint: { method: "POST", path: "/v1/web/fetch" },
  },
  {
    id: "video",
    label: "Video",
    icon: "movie",
    endpoint: { method: "POST", path: "/v1/videos/generations" },
  },
  {
    id: "music",
    label: "Music",
    icon: "music_note",
    endpoint: { method: "POST", path: "/v1/audio/music" },
  },
];

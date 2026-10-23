// Stored object suffix is authoritative, including pre-migration MP3s.
export function audioMedia(episode) {
  return episode.object_key?.endsWith('.m4a')
    ? {extension:'m4a',mime:'audio/mp4'} : {extension:'mp3',mime:'audio/mpeg'};
}

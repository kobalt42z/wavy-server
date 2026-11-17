/*
 * Public API of @wavy/angular.
 */

// Setup
export * from './lib/core/config';
export * from './lib/core/hls-loader';

// Components
export * from './lib/video/wavy-video.component';
export * from './lib/audio/wavy-audio.component';
export * from './lib/directive/stream-support.directive';

// Building blocks for custom players
export * from './lib/core/wavy.service';
export * from './lib/core/player';
export * from './lib/core/media-controller';
export * from './lib/core/errors';
export * from './lib/core/types';
export * from './lib/audio/waveform';

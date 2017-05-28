'use strict';

define([
	'objects/song',
	'pipeline/pipeline',
	'pageAction',
	'timer',
	'notifications',
	'services/background-ga',
	'pipeline/local-cache',
	'services/scrobbleService'
], function(Song, Pipeline, PageAction, Timer, Notifications, GA, LocalCache, ScrobbleService) {
	/**
	 * Check if array of results contains at least one goog result.
	 * @param  {Array} results Array of results
	 * @return {Boolean} True if at least one good result is found
	 */
	function isAnyOkResult(results) {
		return results.some((result) => result.isOk());
	}

	/**
	 * Controller for each tab.
	 *
	 * @constructor
	 * @param {Number} tabId Tab ID
	 * @param {Object} connector Connector match object
	 * @param {Boolean} enabled Flag indicates initial stage
	 */
	return function(tabId, connector, enabled) {
		debugLog(`Created controller for ${connector.label} connector`);

		const pageAction = new PageAction(tabId);
		const playbackTimer = new Timer();
		const replayDetectionTimer = new Timer();

		let currentSong = null;
		let isReplayingSong = false;

		let isEnabled = true;


		/**
		 * React on state change.
		 * @param {Object} newState State of connector
		 */
		this.onStateChanged = function(newState) {
			if (!isEnabled) {
				return;
			}

			// empty state has same semantics as reset; even if isPlaying, we don't have enough data to use
			var isEmptyState = (!(newState.artist && newState.track) && !newState.uniqueID && !newState.duration);

			if (isEmptyState) {
				// throw away last song and reset state
				if (currentSong !== null) {
					debugLog('Received empty state - resetting');
					this.resetState();
				}

				// warning for connector developer
				if (newState.isPlaying) {
					debugLog(`State from connector doesn't contain enough information about the playing track:\n${JSON.stringify(newState)}`);
				}

				return;
			}

			//
			// from here on there is at least some song data
			//

			var hasSongChanged = (currentSong === null || newState.artist !== currentSong.parsed.artist || newState.track !== currentSong.parsed.track ||
															newState.album !== currentSong.parsed.album || newState.uniqueID !== currentSong.parsed.uniqueID);

			if (hasSongChanged && !newState.isPlaying) {
				return;
			}

			// propagate values that can change without changing the song
			if (!hasSongChanged && !isReplayingSong) {
				if (currentSong && currentSong.flags.isSkipped) {
					return;
				}

				// logging same message over and over saves space in console
				if (newState.isPlaying === currentSong.parsed.isPlaying) {
					debugLog('State update: only currentTime has changed');
				} else {
					debugLog(`State update: ${JSON.stringify(newState)}`);
				}

				currentSong.parsed.attr({
					currentTime: newState.currentTime,
					isPlaying: newState.isPlaying,
					trackArt: newState.trackArt,
				});

				if (newState.duration && !currentSong.parsed.duration) {
					updateSongDuration(newState.duration);
				}
			} else {
				// We've hit a new song (or replaying the previous one)
				// clear any previous song and its bindings
				this.resetState();

				currentSong = new Song(newState, connector);

				bindSongListeners(currentSong, { notify: !isReplayingSong });
				debugLog(`New song detected: ${JSON.stringify(currentSong.attr())}`);

				// start the timer, actual time will be set after processing is done;
				// we can call doScrobble directly, because the timer will be allowed to trigger only after the song is validated
				playbackTimer.start(function() {
					doScrobble(currentSong);
				});

				replayDetectionTimer.start(() => {
					isReplayingSong = true;
				});

				// if we just detected the track and it's not playing yet, pause the timer right away;
				// this is important, because isPlaying flag binding only calls pause/resume which assumes the timer is started
				if (!newState.isPlaying) {
					playbackTimer.pause();
					replayDetectionTimer.pause();
				}

				// start processing - result will trigger the listener
				processSong(currentSong);
				isReplayingSong = false;
			}
		};

		/**
		 * Update song duration value.
		 * @param  {Number} duration Duration in seconds
		 */
		function updateSongDuration(duration) {
			currentSong.parsed.attr({ duration });

			if (currentSong.isValid()) {
				playbackTimer.update(currentSong.getSecondsToScrobble());
				replayDetectionTimer.update(duration - Math.floor(Date.now() / 1000) - currentSong.metadata.startTimestamp);

				let remainedSeconds = playbackTimer.getRemainingSeconds();
				debugLog(`Update duration: ${duration}`);
				debugLog(`The song will be scrobbled after ${remainedSeconds} more seconds of playback`);
			}
		}

		/**
		 * Setup listeners for new song object.
		 * @param {Object} song Song instance
		 * @param {Object} options Options
		 */
		function bindSongListeners(song, options = {}) {
			/**
			 * Respond to changes of not/playing and pause timer accordingly to get real elapsed time
			 */
			song.bind('parsed.isPlaying', function(ev, newVal) {
				debugLog(`isPlaying state changed to ${newVal}`);

				if (newVal) {
					playbackTimer.resume();
					replayDetectionTimer.resume();

					// maybe the song was not marked as playing yet
					if (!song.flags.isMarkedAsPlaying && song.isValid()) {
						setSongNowPlaying(song, options);
					}
				} else {
					playbackTimer.pause();
					replayDetectionTimer.pause();
				}
			});

			/**
			 * Song has gone through processing pipeline
			 * This event may occur repeatedly, e.g. when triggered on page load and then corrected by user input
			 */
			song.bind('flags.isProcessed', (ev, newVal) => {
				if (newVal) {
					debugLog(`Song finished processing:\n${JSON.stringify(song.attr())}`);
					onProcessed(song, options);
					notifySongIsUpdated(song);
				} else {
					debugLog(`Song unprocessed:\n${JSON.stringify(song.attr())}`);
					onUnProcessed();
				}
			});
		}

		/**
		 * Unbind all song listener. The song will no longer be used in
		 * Controller, but may remain in async calls and we don't want it
		 * to trigger any more listeners.
		 * @param {Object} song Song instance
		 */
		function unbindSongListeners(song) {
			song.unbind('parsed.isPlaying');
			song.unbind('flags.isProcessed');
		}

		/**
		 * Notify other modules song is updated.
		 * @param {Object} song Song instance
		 */
		function notifySongIsUpdated(song) {
			let type = 'v2.songUpdated';
			let data = song.attr();

			chrome.runtime.sendMessage({ type, data, tabId });
		}

		/**
		 * Reset controller state.
		 */
		this.resetState = function() {
			pageAction.setSiteSupported();
			playbackTimer.reset();
			replayDetectionTimer.reset();

			if (currentSong !== null) {
				unbindSongListeners(currentSong);
				clearNotification(currentSong);
			}
			currentSong = null;
		};

		/**
		 * Called when song finishes processing in pipeline. It may not have
		 * passed the pipeline successfully, so checks for various flags
		 * are needed.
		 * @param {Object} song Song instance
		 * @param {Object} options Options
		 */
		function onProcessed(song, options = {}) {
			// song is considered valid if either L.FM or the user validated it
			if (song.isValid()) {
				// processing cleans this flag
				song.flags.attr('isMarkedAsPlaying', false);

				// set time-to-scrobble
				playbackTimer.update(song.getSecondsToScrobble());
				replayDetectionTimer.update(song.getDuration());

				let remainedSeconds = playbackTimer.getRemainingSeconds();
				debugLog(`The song will be scrobbled after ${remainedSeconds} more seconds of playback`);

				// if the song is playing, mark it immediately; otherwise will be flagged in isPlaying binding
				if (song.parsed.isPlaying) {
					setSongNowPlaying(song, options);
				} else {
					pageAction.setSiteSupported();
				}
			} else {
				setSongNotRecognized();
			}
		}

		/**
		 * Called when song was already flagged as processed, but now is
		 * entering the pipeline again.
		 */
		function onUnProcessed() {
			debugLog('Clearing playback timer destination time');
			playbackTimer.update(null);
			replayDetectionTimer.update(null);
		}

		/**
		 * Contains all actions to be done when song is ready to be marked as
		 * now playing.
		 * @param {Object} song Song instance
		 */
		function setSongNowPlaying(song, { notify = true } = {}) {
			if (notify) {
				Notifications.showPlaying(song);
			}

			ScrobbleService.sendNowPlaying(song).then((results) => {
				if (isAnyOkResult(results)) {
					debugLog('Song set as now playing');
					pageAction.setSongRecognized(song);
				} else {
					debugLog('Song isn\'t set as now playing');
					pageAction.setError();
				}
			});

			song.flags.attr('isMarkedAsPlaying', true);
		}

		/**
		 * Notify user that song it not recognized by the extension.
		 */
		function setSongNotRecognized() {
			pageAction.setSongNotRecognized();
			Notifications.showSongNotRecognized();
		}

		/**
		 * Called when scrobble timer triggers.
		 * The time should be set only after the song is validated and ready
		 * to be scrobbled.
		 * @param {Object} song Song instance
		 */
		function doScrobble(song) {
			debugLog(`Scrobbling ${song.getArtistTrackString()}`);

			ScrobbleService.scrobble(song).then((results) => {
				if (isAnyOkResult(results)) {
					console.info('Scrobbled successfully');

					song.flags.attr('isScrobbled', true);
					pageAction.setSongScrobbled(song);

					notifySongIsUpdated(song);

					GA.event('core', 'scrobble', connector.label);
				} else {
					console.error('Scrobbling failed');

					pageAction.setError();
				}
			});
		}

		/**
		 * Process song using pipeline module.
		 * @param {Object} song Song instance
		 */
		function processSong(song) {
			pageAction.setSongLoading(song);
			Pipeline.processSong(song);
		}

		/**
		 * Clear now playing notification for given song.
		 * @param {Object} song Song instance
		 */
		function clearNotification(song) {
			// Remove notification if song was not scrobbled.
			if (!song.flags.isScrobbled) {
				Notifications.remove(song.metadata.notificationId);
			}
		}

		/**
		 * Get current song as plain object.
		 * @return {Object} Song copy
		 */
		this.getCurrentSong = function() {
			return currentSong === null ? {} : currentSong.attr();
		};

		/**
		 * Sets data for current song from user input
		 * TODO: check if all is ok for case when song is already valid
		 * @param {Object} data Object contains song data
		 */
		this.setUserSongData = function(data) {
			if (currentSong !== null) {
				if (currentSong.flags.isScrobbled) {
					// should not happen
					debugLog('Attempted to enter user data for already scrobbled song');
					return;
				}

				if (data.artist) {
					currentSong.metadata.attr('userArtist', data.artist);
				}
				if (data.track) {
					currentSong.metadata.attr('userTrack', data.track);
				}
				if (data.album) {
					currentSong.metadata.attr('userAlbum', data.album);
				}

				// re-send song to pipeline
				if (data.artist || data.track || data.album) {
					processSong(currentSong);
				}
			}
		};

		/**
		 * Reset song data and process it again.
		 */
		this.resetSongData = function() {
			if (currentSong !== null) {
				currentSong.resetSongData();
				LocalCache.removeSongFromStorage(currentSong).then(() => {
					processSong(currentSong);
				});
			}
		};

		/**
		 * Send request to love or unlove current song.
		 * @param  {boolean} isLoved Flag indicated song is loved
		 * @return {Promise} Promise that will be resolved when the task has complete
		 */
		this.toggleLove = function(isLoved) {
			if (currentSong !== null) {
				return ScrobbleService.toggleLove(currentSong, isLoved).then(() => {
					currentSong.metadata.attr('userloved', isLoved);
				});
			}
			return Promise.reject();
		};

		/**
		 * Make the controller to ignore current song.
		 */
		this.skipCurrentSong = function() {
			if (!currentSong) {
				return;
			}

			pageAction.setSongSkipped(currentSong);

			currentSong.flags.attr({ isSkipped: true });

			playbackTimer.reset();
			unbindSongListeners(currentSong);
			clearNotification(currentSong);
		};

		/**
		 * Switch the state of controller.
		 * @param {Boolean} flag True means enabled and vice versa
		 */
		this.setEnabled = function(flag) {
			isEnabled = flag;

			if (isEnabled) {
				pageAction.setSiteSupported();
			} else {
				pageAction.setSiteDisabled();
			}

			if (!isEnabled && currentSong) {
				playbackTimer.reset();
				unbindSongListeners(currentSong);
				clearNotification(currentSong);
			}
		};

		/**
		 * Check if controller is enabled.
		 * @return {Boolean} True if controller is enabled; false otherwise
		 */
		this.isEnabled = function() {
			return isEnabled;
		};

		/**
		 * Get connector match object.
		 * @return {Object} Connector
		 */
		this.getConnector = function() {
			return connector;
		};

		// setup initial page action; the controller means the page was recognized
		this.setEnabled(enabled);

		function debugLog(text) {
			console.log(`Tab ${tabId}: ${text}`);
		}
	};
});

'use strict';

// Native
const EventEmitter = require('events');

// Packages
const HID = require('node-hid');
const jimp = require('jimp');
const NodeCache = require('node-cache');
require('bluefill');

const NUM_KEYS = 15;
const PAGE_PACKET_SIZE = 8191;
const NUM_FIRST_PAGE_PIXELS = 2583;
const NUM_SECOND_PAGE_PIXELS = 2601;
const ICON_SIZE = 72;
const NUM_TOTAL_PIXELS = NUM_FIRST_PAGE_PIXELS + NUM_SECOND_PAGE_PIXELS;
const PANEL_BUTTONS_X = 5;
const PANEL_BUTTONS_Y = 3;
const MIN_UP_TIME = 100; // [milliseconds]

class StreamDeck extends EventEmitter {
	constructor(device) {
		super();

		if (device) {
			this.device = device;
		} else {
			// Device not provided, will then select any connected device:
			const devices = HID.devices();
			const connectedStreamDecks = devices.filter(device => {
				return device.vendorId === 0x0fd9 && device.productId === 0x0060;
			});
			if (!connectedStreamDecks.length) {
				throw new Error('No Stream Decks are connected.');
			}
			this.device = new HID.HID(connectedStreamDecks[0].path);
		}

		this._keyState = (new Array(NUM_KEYS)).fill(null).map(() => {
			return {
				time: 0,
				key: false
			};
		});
		this._internalKeyState = (new Array(NUM_KEYS)).fill(null).map(() => {
			return {
				time: 0,
				key: false
			};
		});

		this.device.on('data', data => {
			// The first byte is a report ID, the last byte appears to be padding
			// strip these out for now.
			data = data.slice(1, data.length - 1);

			for (let i = 0; i < NUM_KEYS; i++) {
				const keyPressed = Boolean(data[i]);
				if (this._keyState[i].key !== keyPressed) {
					this._keyState[i].key = keyPressed;
				}
			}
			this._updateState();
		});

		this.device.on('error', err => {
			this.emit('error', err);
		});

		this.cacheImages = true;
		this._imageCache = new NodeCache({
			stdTTL: 24 * 3600 // TTL (s) for cached images
		});
		this._updateStateTimeout = 0;
	}
	/**
	 * Acts like a filter, to prevent unintentional double-clicks due to glitches in the buttons
	 * Waits MIN_UP_TIME from a button is initially pressed, before the button is considered to be "up" again
	 *
	 * @returns undefined
	 */
	_updateState() {
		let needToCheckLater = false;
		this._internalKeyState.forEach((internalState, i) => {
			const keyState = this._keyState[i];
			if (internalState.key !== keyState.key) {
				if (keyState.key && !internalState.time) {
					internalState.time = Date.now();
				}
				if (
					keyState.key || // Key is pressed down
					(Date.now() - (internalState.time || 0)) > MIN_UP_TIME
				) {
					internalState.key = keyState.key;
					if (keyState.key) {
						this.emit('down', i);
					} else {
						this.emit('up', i);
						internalState.time = 0;
					}
				} else {
					needToCheckLater = true;
				}
			}
		});
		if (needToCheckLater) {
			if (!this._updateStateTimeout) {
				this._updateStateTimeout = setTimeout(() => {
					this._updateStateTimeout = 0;
					this._updateState();
				}, MIN_UP_TIME / 2);
			}
		}
	}

	/**
	 * Writes a Buffer to the Stream Deck.
	 *
	 * @param {Buffer} buffer The buffer written to the Stream Deck
	 * @returns undefined
	 */
	write(buffer) {
		return this.device.write(StreamDeck.bufferToIntArray(buffer));
	}

	/**
	 * Sends a HID feature report to the Stream Deck.
	 *
	 * @param {Buffer} buffer The buffer send to the Stream Deck.
	 * @returns undefined
	 */
	sendFeatureReport(buffer) {
		return this.device.sendFeatureReport(StreamDeck.bufferToIntArray(buffer));
	}

	/**
	 * Fills the given key with a solid color.
	 *
	 * @param {number} keyIndex The key to fill 0 - 14
	 * @param {number} r The color's red value. 0 - 255
	 * @param {number} g The color's green value. 0 - 255
	 * @param {number} b The color's blue value. 0 -255
	 */
	fillColor(keyIndex, r, g, b) {
		StreamDeck.checkValidKeyIndex(keyIndex);

		StreamDeck.checkRGBValue(r);
		StreamDeck.checkRGBValue(g);
		StreamDeck.checkRGBValue(b);

		const pixel = Buffer.from([b, g, r]);
		this._writePage1(keyIndex, Buffer.alloc(NUM_FIRST_PAGE_PIXELS * 3, pixel));
		this._writePage2(keyIndex, Buffer.alloc(NUM_SECOND_PAGE_PIXELS * 3, pixel));
	}

	/**
	 * Checks a value is a valid RGB value. A number between 0 and 255.
	 *
	 * @static
	 * @param {number} value The number to check
	 */
	static checkRGBValue(value) {
		if (value < 0 || value > 255) {
			throw new TypeError('Expected a valid color RGB value 0 - 255');
		}
	}

	/**
	 * Checks a keyIndex is a valid key for a stream deck. A number between 0 and 14.
	 *
	 * @static
	 * @param {number} keyIndex The keyIndex to check
	 */
	static checkValidKeyIndex(keyIndex) {
		if (keyIndex < 0 || keyIndex > 14) {
			throw new TypeError('Expected a valid keyIndex 0 - 14');
		}
	}

	/**
	 * Fills the given key with an image in a Buffer.
	 *
	 * @param {number} keyIndex The key to fill 0 - 14
	 * @param {Buffer} imageBuffer
	 */
	fillImage(keyIndex, imageBuffer) {
		StreamDeck.checkValidKeyIndex(keyIndex);

		if (imageBuffer.length !== 15552) {
			throw new RangeError(`Expected image buffer of length 15552, got length ${imageBuffer.length}`);
		}

		let pixels = [];
		for (let r = 0; r < ICON_SIZE; r++) {
			const row = [];
			const start = r * 3 * ICON_SIZE;
			for (let i = start; i < start + (ICON_SIZE * 3); i += 3) {
				const r = imageBuffer.readUInt8(i);
				const g = imageBuffer.readUInt8(i + 1);
				const b = imageBuffer.readUInt8(i + 2);
				row.push(b, g, r);
			}
			pixels = pixels.concat(row);
		}
		pixels.reverse();

		const firstPagePixels = pixels.slice(0, NUM_FIRST_PAGE_PIXELS * 3);
		const secondPagePixels = pixels.slice(NUM_FIRST_PAGE_PIXELS * 3, NUM_TOTAL_PIXELS * 3);
		this._writePage1(keyIndex, Buffer.from(firstPagePixels));
		this._writePage2(keyIndex, Buffer.from(secondPagePixels));
	}

	/**
	 * Fill's the given key with an image from a file.
	 *
	 * @param {number} keyIndex The key to fill 0 - 14
	 * @param {String} filePath A file path to an image file
	 * @returns {Promise<void>} Resolves when the file has been written
	 */
	fillImageFromFile(keyIndex, filePath) {
		StreamDeck.checkValidKeyIndex(keyIndex);
		return this._getCachedImageFromPath(filePath, this._manipulateStandardImage)
			.then(imageBuffer => {
				const shouldBeSize = ICON_SIZE * ICON_SIZE * 3;
				this.fillImage(keyIndex, imageBuffer.slice(imageBuffer.length - shouldBeSize));
			});
	}
	/**
	 * Fill's the whole panel with an image from a file. The file is scaled to fit (no stretching)
	 * @param {String} filePath A file path to an image file
	 * @returns {Promise<void>} Resolves when the file has been written
	 */
	fillImageOnAll(filePath) {
		return new Promise((resolve, reject) => {
			this._getCachedImageFromPath(filePath, (image, callback) => {
				image.contain(PANEL_BUTTONS_X * ICON_SIZE, PANEL_BUTTONS_Y * ICON_SIZE);

				// Prepare all button-images and save to cache:
				const buttons = [];
				for (let y = 0; y < PANEL_BUTTONS_Y; y++) {
					for (let x = 0; x < PANEL_BUTTONS_X; x++) {
						buttons.push({
							i: (y * PANEL_BUTTONS_X) + PANEL_BUTTONS_X - x - 1,
							x,
							y
						});
					}
				}

				Promise.map(
					buttons,
					button => {
						return new Promise((resolve, reject) => {
							image
								.clone()
								.crop(button.x * ICON_SIZE, button.y * ICON_SIZE, ICON_SIZE, ICON_SIZE)
								.getBuffer(jimp.MIME_BMP, (err, imageBuffer) => {
									if (err) {
										reject(err);
									} else {
										resolve({
											button,
											imageBuffer
										});
									}
								});
						});
					})
					.then(buttonImageBuffers => {
						callback(null, buttonImageBuffers);
					})
					.catch(e => {
						callback(e, null);
					});
			})
			.then(buttonImageBuffers => {
				buttonImageBuffers.forEach(buttonImageBuffer => {
					const shouldBeSize = ICON_SIZE * ICON_SIZE * 3;
					this.fillImage(
						buttonImageBuffer.button.i,
						buttonImageBuffer.imageBuffer.slice(buttonImageBuffer.imageBuffer.length - shouldBeSize)
					);
				});
				resolve();
			})
			.catch(e => {
				reject(e);
			});
		});
	}
	/**
	 * Prepares the given images, putting them in the cache for quicker later use
	 * @param {Array<String>} filePaths: an array of filePaths
	 * @returns {Promise<void>} Resolves when the files have been prepared
	 */
	prepareFiles(filePaths) {
		return Promise.map(
			filePaths,
			filePath => {
				// Do the standard manipulation to cache it:
				return this._getCachedImageFromPath(filePath, this._manipulateStandardImage);
			});
	}

	/**
	 * Clears the given key.
	 *
	 * @param {number} keyIndex The key to clear 0 - 14
	 * @returns {undefined}
	 */
	clearKey(keyIndex) {
		StreamDeck.checkValidKeyIndex(keyIndex);

		return this.fillColor(keyIndex, 0, 0, 0);
	}

	/**
	 * Sets the brightness of the keys on the Stream Deck
	 *
	 * @param {number} percentage The percentage brightness
	 */
	setBrightness(percentage) {
		if (percentage < 0 || percentage > 100) {
			throw new RangeError('Expected brightness percentage to be between 0 and 100');
		}
		this.sendFeatureReport(this._padToLength(Buffer.from([0x05, 0x55, 0xaa, 0xd1, 0x01, percentage]), 17));
	}
	_manipulateStandardImage(image) {
		return image.cover(ICON_SIZE, ICON_SIZE);
	}
	/**
	 * Fetches a image, either from filePath or cache
	 *
	 * @param {String} filePath A file path to an image file
	 * @param {function} imageManipulatorCallback either a synchronous function or a callback-style function
	 *   that manipulates the image before it is stored in the cache
	 * @returns {Promise<imageBuffer>} Resolves when the file has fetched
	 */
	_getCachedImageFromPath(filePath, imageManipulatorCallback) {
		return new Promise((resolve, reject) => {
			if (this.cacheImages) {
				if (!imageManipulatorCallback) {
					imageManipulatorCallback = '';
				}
				const cacheKey = filePath + '_' + imageManipulatorCallback.toString();
				this._imageCache.get(cacheKey, (err, imageBuffer) => {
					if (err) {
						reject(err);
					} else if (imageBuffer === undefined) {
						// No hit in cache
						this._getImageFromPath(filePath, imageManipulatorCallback)
							.then(imageBuffer => {
								this._imageCache.set(cacheKey, imageBuffer, err => {
									if (err) {
										reject(err);
									} else {
										resolve(imageBuffer);
									}
								});
							})
							.catch(e => {
								reject(e);
							});
					} else {
						resolve(imageBuffer);
					}
				});
			} else {
				this._getImageFromPath(filePath, imageManipulatorCallback)
					.then(imageBuffer => {
						resolve(imageBuffer);
					})
					.catch(e => {
						reject(e);
					});
			}
		});
	}
	/**
	 * Fetches an image from a file path, allowing for a step of manipulation before returning it
	 *
	 * @param {String} filePath A file path to an image file
	 * @param {function} imageManipulatorCallback either a synchronous function or a callback-style function
	 *   that manipulates the image before it is stored in the cache
	 * @returns {Promise<imageBuffer>} Resolves when the file has fetched
	 */
	_getImageFromPath(filePath, imageManipulatorCallback) {
		return new Promise((resolve, reject) => {
			jimp.read(filePath)
				.then(image => {
					const finalizeFcn = function (err, imageOrImageBuffer) {
						if (err) {
							reject(err);
						} else if (!imageOrImageBuffer) {
							reject(new Error('Bad value returned from callback function!'));
						} else if (imageOrImageBuffer instanceof jimp) {
							// Is an image
							imageOrImageBuffer.getBuffer(jimp.MIME_BMP, (err, imageBuffer) => {
								if (err) {
									reject(err);
								} else {
									resolve(imageBuffer);
								}
							});
						} else {
							// Is a image buffer (or whatever the manipulator function returned)
							resolve(imageOrImageBuffer);
						}
					};
					if (typeof imageManipulatorCallback === 'function') {
						const manipulatedImage = imageManipulatorCallback(image, finalizeFcn);
						if (manipulatedImage) {
							finalizeFcn(null, manipulatedImage);
						} // Else we're expecting the function to call it's callback
					}
				})
				.catch(e => {
					reject(e);
				})
			;
		});
	}
	/**
	 * Writes a Stream Deck's page 1 headers and image data to the Stream Deck.
	 *
	 * @private
	 * @param {number} keyIndex The key to write to 0 - 14
	 * @param {Buffer} buffer Image data for page 1
	 * @returns {undefined}
	 */
	_writePage1(keyIndex, buffer) {
		const header = Buffer.from([
			0x02, 0x01, 0x01, 0x00, 0x00, keyIndex + 1, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			0x42, 0x4d, 0xf6, 0x3c, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x36, 0x00, 0x00, 0x00, 0x28, 0x00,
			0x00, 0x00, 0x48, 0x00, 0x00, 0x00, 0x48, 0x00,
			0x00, 0x00, 0x01, 0x00, 0x18, 0x00, 0x00, 0x00,
			0x00, 0x00, 0xc0, 0x3c, 0x00, 0x00, 0xc4, 0x0e,
			0x00, 0x00, 0xc4, 0x0e, 0x00, 0x00, 0x00, 0x00,
			0x00, 0x00, 0x00, 0x00, 0x00, 0x00
		]);

		const packet = this._padToLength(Buffer.concat([header, buffer]), PAGE_PACKET_SIZE);
		return this.write(packet);
	}

	/**
	 * Writes a Stream Deck's page 2 headers and image data to the Stream Deck.
	 *
	 * @private
	 * @param {number} keyIndex The key to write to 0 - 14
	 * @param {Buffer} buffer Image data for page 2
	 * @returns {undefined}
	 */
	_writePage2(keyIndex, buffer) {
		const header = Buffer.from([0x02, 0x01, 0x02, 0x00, 0x01, keyIndex + 1]);
		const packet = this._padToLength(Buffer.concat([header, this._pad(10), buffer]), PAGE_PACKET_SIZE);
		return this.write(packet);
	}

	/**
	 * Pads a given buffer till padLength with 0s.
	 *
	 * @private
	 * @param {Buffer} buffer Buffer to pad
	 * @param {number} padLength The length to pad to
	 * @returns {Buffer} The Buffer padded to the length requested
	 */
	_padToLength(buffer, padLength) {
		return Buffer.concat([buffer, this._pad(padLength - buffer.length)]);
	}

	/**
	 * Returns an empty buffer (filled with zeroes) of the given length
	 *
	 * @private
	 * @param {number} padLength Length of the buffer
	 * @returns {Buffer}
	 */
	_pad(padLength) {
		return Buffer.alloc(padLength);
	}

	/**
	 * The pixel size of an icon written to the Stream Deck key.
	 *
	 * @readonly
	 */
	get ICON_SIZE() {
		return ICON_SIZE;
	}

	/**
	 * Converts a buffer into an number[]. Used to supply the underlying
	 * node-hid device with the format it accepts.
	 *
	 * @static
	 * @param {Buffer} buffer Buffer to convert
	 * @returns {number[]} the converted buffer
	 */
	static bufferToIntArray(buffer) {
		const array = [];
		for (const pair of buffer.entries()) {
			array.push(pair[1]);
		}
		return array;
	}
}

module.exports = StreamDeck;

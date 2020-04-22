const fs = require('fs');
var archiver = require('archiver');
const { URL } = require('url');
const urlParser = require('url');
const {
	DEBUG,
	HEADFUL,
	CHROME_BIN,
	PORT
} = process.env;

const puppeteer = require('puppeteer');
const cdnDetector = require("cdn-detector");
const jimp = require('jimp');
const pTimeout = require('p-timeout');
/*
	const LRU = require('lru-cache');
	const cache = LRU({
		max: process.env.CACHE_SIZE || Infinity,
		maxAge: 1000 * 60, // 1 minute
		noDisposeOnSet: true,
		dispose: async (url, page) => {
			try {
				if (page && page.close) {
					console.log('🗑 Disposing ' + url);
					page.removeAllListeners();
					await page.deleteCookie(await page.cookies());
					await page.close();
				}
			} catch (e) {}
		}
	});
	setInterval(() => cache.prune(), 1000 * 60); // Prune every minute
*/

const autoScroll = async (page) => {
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      let totalHeight = 0
      let distance = 100
      let timer = setInterval(() => {

		let scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
		totalHeight += distance;
		
        if (totalHeight >= scrollHeight){
		  clearInterval(timer);
          resolve();
		}
		
      }, 300);
    });
  });
};


const blocked = require('./blocked.json');
const blockedRegExp = new RegExp('(' + blocked.join('|') + ')', 'i');

const truncate = (str, len) => str.length > len ? str.slice(0, len) + '…' : str;



let browser = {};

require('http').createServer(async (req, res) => {
	const { host } = req.headers;

	if (req.url == '/') { // !!!
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'public,max-age=31536000',
		});
		res.end(fs.readFileSync('src/index.html'));
		return;
	}

	if (req.url == '/favicon.ico') {
		res.writeHead(204);
		res.end();
		return;
	}

	if (req.url == '/status') {
		res.writeHead(200, {
			'content-type': 'application/json',
		});
		res.end(JSON.stringify({
			//pages: cache.keys(),
			process: {
				versions: process.versions,
				memoryUsage: process.memoryUsage(),
			},
		}, null, '\t'));
		return;
	}


	const queryData = urlParser.parse(req.url, true).query;
	const action = queryData.action || '';
	const url = queryData.url || '';


	// URL CHECKS
	if (!url) {
		res.writeHead(400, {
			'content-type': 'text/plain',
		});
		res.end('Something is wrong. Missing URL.');
		return;
	}

	if (!/^https?:\/\//i.test(url)) {
		res.writeHead(400, {
			'content-type': 'text/plain',
		});
		res.end('Invalid URL.');
		return;
	}


	/*
		// TOO MUCH CACHE
		if (cache.itemCount > 20) {
			res.writeHead(420, {
				'content-type': 'text/plain',
			});
			res.end(`There are ${cache.itemCount} pages in the current instance now. Please try again in few minutes.`);
			return;
		}
	*/


	let page, pageURL;
	try {


		console.log('🌎 URL: ', url, ' 💥 Action: ', action);


		const parsedRemoteUrl = new URL(url);
		const { origin,	hostname, pathname, searchParams } = new URL(url);
		const path = decodeURIComponent(pathname);
		const output = queryData.output;

		/*
			await new Promise((resolve, reject) => {
				const req = http.request({
					method: 'HEAD',
					host: hostname,
					path,
				}, ({
					statusCode,
					headers
				}) => {
					if (!headers || (statusCode == 200 && !/text\/html/i.test(headers['content-type']))) {
						reject(new Error('Not a HTML page'));
					} else {
						resolve();
					}
				});
				req.on('error', reject);
				req.end();
			});
		*/

		pageURL = origin + path; console.log('🌎 pageURL: ', pageURL);
		let realPageURL = pageURL;
		let actionDone = false;

		const width = parseInt(queryData.width, 10) || 1024;
		const height = parseInt(queryData.height, 10) || 768;

		const project_ID = parseInt(queryData.project_ID) || 0;
		const page_ID = parseInt(queryData.page_ID) || 0;
		const phase_ID = parseInt(queryData.phase_ID) || 0;
		const device_ID = parseInt(queryData.device_ID) || 0;

		const browser_ID = project_ID + '-' + page_ID + '-' + phase_ID + '-' + device_ID + '-' + Math.random().toString(36).substring(7);

		const fullPage = queryData.fullPage == 'true' || false;
		const page_type = queryData.page_type || 'url';
		const SSR = page_type == 'ssr';
		const capture = page_type == 'capture';

		const siteDir = 'cache/projects/project-'+project_ID+'/page-'+page_ID+'/phase-'+phase_ID+'/';
		const logDir = siteDir + 'logs/';


		// Create the log folder if not exist
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
			try{ fs.chownSync(logDir, 33, 33); } catch(e) {}
		}


		// Create the log file
		fs.writeFileSync(logDir+'browser.log', 'Started');
		try{ fs.chownSync(logDir+'browser.log', 33, 33); } catch(e) {}



		let downloadableRequests = [];



		// Page check from cache
		//page = cache.get(pageURL); if (page) console.log('Page found from cache.');


		// If page is not already open
		if (!page) {


			// Launch the browser if browser is not already open
			if (!browser[browser_ID]) {
				console.log('🚀 Launch browser!');
				const config = {
					ignoreHTTPSErrors: true,
					args: [
						'--no-sandbox',
						'--disable-setuid-sandbox',
						'--disable-dev-shm-usage',
						'--enable-features=NetworkService',
						'-—disable-dev-tools',
					],
					devtools: false,
				};
				if (DEBUG) config.dumpio = true;
				if (HEADFUL) {
					config.headless = false;
					config.args.push('--auto-open-devtools-for-tabs');
				}
				if (CHROME_BIN) config.executablePath = CHROME_BIN;
				browser[browser_ID] = await puppeteer.launch(config);
			}



			// Open a new tab
			page = await browser[browser_ID].newPage();



			// REQUEST
			let htmlCount = 0;
			let jsCount = 0;
			let cssCount = 0;
			let fontCount = 0;

			const nowTime = +new Date();
			let reqCount = 0;
			await page.setRequestInterception(true);
			page.on('request', (request) => {


				// Update the real page URL
				if (page.url() != 'about:blank' && realPageURL != page.url()) {

					realPageURL = page.url();
					console.log('🌎 Real Page URL: ', realPageURL);

				}


				const parsedRealURL = new URL(realPageURL);
				const ourHost = parsedRealURL.hostname;


				const url = request.url();
				const parsedUrl = new URL(url);
				const requestHost = parsedUrl.hostname;
				const shortURL = truncate(url, 70);
				const method = request.method();
				const resourceType = request.resourceType();

				// Skip data URIs
				if (/^data:/i.test(url)) {
					request.continue();
					return;
				}

				// Get the filename
				const split = parsedUrl.pathname.split('/');
				let fileName = split[split.length - 1];

				if (fileName == '') fileName += 'index';

				if (!fileName.includes('.')) {

				    if (resourceType == 'document') fileName += '.html';
				    else if (resourceType == 'stylesheet') fileName += '.css';
				    else if (resourceType == 'script') fileName += '.js';

				}

				// Get the file extension
				const extsplit = fileName.split('.');
				const fileExtension = extsplit[extsplit.length - 1];
				const fileType = resourceType;


				const seconds = (+new Date() - nowTime) / 1000;
				const otherResources = /^(manifest|other)$/i.test(resourceType);
				// Abort requests that exceeds 15 seconds
				// Also abort if more than 100 requests
				if (seconds > 10 && !capture) {
					console.log(`❌⏳ ${method} ${resourceType} ${shortURL}`);
					request.abort();
				} else if (reqCount > 200) {
					console.log(`❌📈 ${method} ${resourceType} ${shortURL}`);
					request.abort();
				} else if (actionDone) {
					console.log(`❌🔚 ${method} ${resourceType} ${shortURL}`);
					request.abort();
				} else if (blockedRegExp.test(url)) {
					console.log(`❌🚫 ${method} ${resourceType} ${shortURL}`);
					request.abort();
				} else if (otherResources) {
					console.log(`❌♨️ ${method} ${resourceType} ${shortURL}`);
					request.abort();
				} else if (
					ourHost != requestHost &&
					//cdnDetector.detectFromHostname(requestHost) != null &&
					(
						requestHost == "connect.facebook.net"
						|| requestHost == "www.facebook.com"
						|| requestHost == "www.google.com"
						|| requestHost == "www.gstatic.com"
						|| requestHost == "fonts.gstatic.com"
						|| requestHost == "stats.wp.com"
						|| requestHost == "s0.wp.com"
						|| requestHost == "bid.g.doubleclick.net"
					)
				) {
					console.log(`❌🌪 ${method} ${resourceType} ${shortURL}`);
					request.abort();
				} else {


					if (url == realPageURL) console.log('🏠 HOME REQUEST:', url);


					console.log(`✅ ALLOWED REQUEST: ${method} ${resourceType} ${fileName} ${shortURL}`);
					request.continue();
					reqCount++;


				} // If request allowed



			}); // THE REQUESTS LOOP




			// REQUEST FINISHED
			let responseCount = 0;
			let bufferCount = 0;
			page.on('requestfinished', async (request) => {

				responseCount++;


				// Response info
			    const response = await request.response();
			    const response_status = response.status();
			    const response_url = response.url();



				console.log('REQUEST FINISHED:', truncate(response_url, 70));



			    // Request info
				const parsedRealURL = new URL(realPageURL);
				const ourHost = parsedRealURL.hostname;


				const url = request.url();
				const parsedUrl = new URL(url);
				const requestHost = parsedUrl.hostname;
				const shortURL = truncate(url, 70);
				const method = request.method();
				const resourceType = request.resourceType();


				// Get the filename
				const split = parsedUrl.pathname.split('/');
				let fileName = split[split.length - 1];

				if (fileName == '') fileName += 'index';

				if (!fileName.includes('.')) {

				    if (resourceType == 'document') fileName += '.html';
				    else if (resourceType == 'stylesheet') fileName += '.css';
				    else if (resourceType == 'script') fileName += '.js';

				}

				// Get the file extension
				const extsplit = fileName.split('.');
				const fileExtension = extsplit[extsplit.length - 1];
				const fileType = resourceType;



				// Detect CDN
				let fromCDN = false;
				if (ourHost != requestHost && cdnDetector.detectFromHostname(requestHost) != null) {
					console.log('🌪 CDN DETECTED: ', requestHost);
					fromCDN = true;
				}




				// If on the same host, or provided by a CDN
				if ( ourHost == requestHost || ourHost == requestHost.replace('www.', '') || fromCDN ) {


					let shouldDownload = true;
					let newFileName = "noname.txt";
					let newDir = "temp/";


					// HTML File
					if (resourceType == 'document' && (ourHost == requestHost || ourHost == requestHost.replace('www.', ''))) {

						htmlCount++;
						newDir = "";
						newFileName = 'index.html';

					}

					// CSS Files
					else if (fileType == 'stylesheet') {

						cssCount++;
						newDir = "css/";
						newFileName = cssCount + '.css';

					}

					// JS Files
					else if (fileType == 'script') {

						jsCount++;
						newDir = "js/";
						newFileName = jsCount + '.js';

					}

					// Font Files
					else if (fileType == 'font') {

						fontCount++;
						newDir = "fonts/";
						newFileName = fileName;

					}

					// If none of them
					else {

						shouldDownload = false;
						console.log(`📄❌ NOT ALLOWED TYPE: ${fileType} ${fileName} ${shortURL}`);

					}



					// Add to the list
					if (shouldDownload) {


						// Prepend the site directory
						newDir = siteDir + newDir;


						// Get the buffer
						response.buffer().then(buffer => { bufferCount++;

							if (response_url == realPageURL) console.log('🏠 HOME BUFFER READY:', response_url);


							if (buffer != null) {


								downloadableRequests.push(
									{
										remoteUrl: url,
										fileType: resourceType,
										fileName: fileName,
										newDir: newDir,
										newFileName: newFileName,
										buffer: buffer
									}
								);


								if (response_url == realPageURL) console.log('🏠 HOME BUFFER ADDED:', response_url);
								else console.log(`📋✅ BUFFER ADDED: #${bufferCount} ${method} ${resourceType} ${url}`);

								//console.log(`${b} ${response.status()} ${response.url()} ${b.length} bytes`);


							} else {

								if (response_url == realPageURL) console.log('🏠 HOME EMPTY BUFFER ERROR:', response_url);

								console.error(`📋❌ EMPTY BUFFER: ${response.status()} ${request.resourceType()} ${response.url()}`);

							}



						}, e => {

							if (response_url == realPageURL) console.log('🏠 HOME BUFFER ERROR:', response_url);

							console.error(`📋❌ BUFFER ERROR: ${response.status()} ${request.resourceType()} ${response.url()} failed: ${e}`);

						});

					}


				// If not on our host !!!
				} else {

					console.log(`📄❌ OTHER HOST FILE: ${fileType} ${shortURL}`);
					//console.log('Our Host: ', ourHost);
					//console.log('Request Host: ', requestHost);

				}



			}); // THE REQUEST FINISHED LOOP




			//page.on('requestfailed', nextRequest);





			// RESPONSE
			let responseReject;
			const responsePromise = new Promise((_, reject) => {
				responseReject = reject;
			});
			page.on('response', (response) => {


			}); // THE RESPONSES LOOP






			// ERRORS
			page.on('error', (error) => {


				console.error('🐞 ERROR OCCURED: ', error);



				// Close the page
				try {

					if (page && page.close) {
						console.log('🗑 Tab closing for ' + url);
						page.removeAllListeners();
						page.close().then(buffer => {


							console.log('🗑✅ Tab closed for ' + url);


							if (browser[browser_ID]) {

								console.log('🔌 Closing the browser for ' + url, ' PAGE ID: ' + page_ID, ' DEVICE ID: ' + device_ID);

								browser[browser_ID].close();
								browser[browser_ID] = null;
								delete browser[browser_ID];

								console.log('🔌✅ Browser closed for ' + url, ' PAGE ID: ' + page_ID, ' DEVICE ID: ' + device_ID);

							}

						}, e => {
							console.error(`❌ Page Closing Failed (URL: ${url}): ${e}`);
						});


					}

				} catch (e) {

					console.log('🐞 Closing error: ' + e);

				}


			}); // THE ERRORS LOOP



			// Set the viewport
			console.log('🖥 Setting viewport sizes as ' + width + 'x' + height);
			await page.setViewport({
				width,
				height,
			});



			// Set User Agent
			//await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3419.0 Safari/537.36');



			// Go to the page
			console.log('⬇️ Fetching ' + pageURL);
			await Promise.race([
				responsePromise,
				page.goto(pageURL, {
					waitUntil: 'networkidle2',
					timeout: 10000
				}).then(() => {
			    	console.log('Page successfully loaded.');
				}).catch((res) => {
				    console.log('Page loading failed.', res);
				})
			]);


			// Pause all media and stop buffering
			page.frames().forEach((frame) => {
				frame.evaluate(() => {
					document.querySelectorAll('video, audio').forEach(m => {
						if (!m) return;
						if (m.pause) m.pause();
						m.preload = 'none';
					});
				});
			});



		} else {


			//downloadableRequests = cache.get(pageURL + 'downloadableRequests');


			// Set the viewport
			console.log('🖥 !!! Setting viewport sizes: ' + width + 'x' + height);
			await page.setViewport({
				width,
				height,
			});


		}



		// Download modes
		if (SSR || capture) {

			// Wait
			let waitMs = 2000;
			console.log('⏳ Waiting for '+ (waitMs/1000) +' seconds...');
			await page.waitFor(waitMs);
			console.log('▶️ Continuing the process.');

			// Autoscroll to bottom
			console.log('▶️ Scrolling to bottom...');
			await autoScroll(page);

			// Scroll back to top
			console.log('▶️ Scrolling to top...');
			await page.evaluate(() => {
				window.scrollTo(0, 0);
			});

			console.log('⏳ Waiting for '+ (waitMs/1000) +' seconds...');
			await page.waitFor(waitMs);
			console.log('Page interactions done');

		}



		console.log('💥 Perform action: ' + action);
		console.log('💥 Download Type: ' + page_type);
		//console.log('💥 DOWNLOADABLES: ');
		//console.log(downloadableRequests);



		switch (action) {
			case 'internalize': {


				// Serialized HTML of page DOM
				const renderedHTML = await page.content();


				//console.log('🌎 Real Page URL: ', realPageURL);


				// Create the site folder if not exist
				if (!fs.existsSync(siteDir)) {
					fs.mkdirSync(siteDir, { recursive: true });
					try{ fs.chownSync(siteDir, 33, 33); } catch(e) {}
				}


				// Find all the HTMLs
				var downloadableDocuments = downloadableRequests.filter(function(req){

					if (req.fileType == "document") return true;
					return false;

				});


				// Check if multiple document
				if (downloadableDocuments.length > 1) {


					console.log('HOME - MULTIPLE HTMLS FOUND: ', downloadableDocuments.length);
					console.log('DOWNLOADABLE COUNT: ', downloadableRequests.length);


					// Filter the non-buffered
					downloadableRequests = downloadableRequests.filter(function(req){

						if (req.fileType == "document" && req.buffer == null) return false;
					    return true;

					});


					console.log('🏠 HOME - NON BUFFERED REMOVED');
					console.log('DOWNLOADABLE COUNT: ', downloadableRequests.length);


				}


				let downloadableTotal = downloadableRequests.length;
				let downloadedFiles = [];
				let renderDifference = 0;


				// DOWNLOAD
				downloadableRequests.forEach(function(downloadable, i) {


					try {

						// Create the folder if not exist
						if (!fs.existsSync(downloadable.newDir)) {
							fs.mkdirSync(downloadable.newDir, { recursive: true });
							try{ fs.chownSync(downloadable.newDir, 33, 33); } catch(e) {}
						}

						let buffer = downloadable.buffer;

						if (downloadable.newFileName == "index.html") {


							console.log(downloadable.newFileName, 'BUFFER LENGTH:', buffer.length);
							console.log(downloadable.newFileName, 'renderedHTML LENGTH:', renderedHTML.length);
							renderDifference = renderedHTML.length - buffer.length;
							console.log(downloadable.newFileName, 'DIFFERENCE:', renderDifference);


							// Server side rendered buffer
							if (
								SSR //|| renderDifference > 50000
							) {

								console.log('SERVER SIDE RENDERING');

								// Save the unrendered version first? !!!
								fs.writeFileSync(siteDir + 'original.html', buffer);
								try{ fs.chownSync(siteDir + 'original.html', 33, 33); } catch(e) {}

								buffer = renderedHTML;

							}

						}



						// Write to the file
						fs.writeFileSync(downloadable.newDir + downloadable.newFileName, buffer);
						try{ fs.chownSync(downloadable.newDir + downloadable.newFileName, 33, 33); } catch(e) {}


						// Add to the list
						downloadedFiles[i] = {
							remoteUrl: downloadable.remoteUrl,
							fileType: downloadable.fileType,
							fileName: downloadable.fileName,
							newDir: downloadable.newDir,
							newFileName: downloadable.newFileName,
						};


						const downloadedCount = downloadedFiles.length;
						const downloadableTotal = downloadableRequests.length;
						const downloadedIndex = i + 1;

						console.log(`⏬✅ (${downloadedIndex}/${downloadableTotal}) ${downloadable.fileType} ${downloadable.remoteUrl} -> ` + downloadable.newDir + downloadable.newFileName);

					} catch (err) {

						console.error(`⏬❌ ${downloadable.fileType} ${downloadable.remoteUrl} -> ` + downloadable.newDir + downloadable.newFileName + ' ERROR: ' + err);

					}


				});





				// const zipfilepath = "cache/phase-" + phase_ID + ".zip";
				// if ( fs.existsSync(zipfilepath) ) fs.unlinkSync(zipfilepath);
				// let zipfile = fs.createWriteStream(zipfilepath);
				// var archive = archiver('zip', {
				// 	zlib: { level: 9 } // Sets the compression level.
				// });


				// // listen for all archive data to be written
				// // 'close' event is fired only when a file descriptor is involved
				// zipfile.on('close', function() {
				// 	console.log(archive.pointer() + ' total bytes');
				// 	console.log('archiver has been finalized and the output file descriptor has closed.');
				// });
				
				// // This event is fired when the data source is drained no matter what was the data source.
				// // It is not part of this library but rather from the NodeJS Stream API.
				// // @see: https://nodejs.org/api/stream.html#stream_event_end
				// zipfile.on('end', function() {
				// 	console.log('Data has been drained');
				// });
 
				// // good practice to catch warnings (ie stat failures and other non-blocking errors)
				// archive.on('warning', function(err) {
				//   if (err.code === 'ENOENT') {
				// 	// log warning
				//   } else {
				// 	// throw error
				// 	throw err;
				//   }
				// });
				 
				// // good practice to catch this error explicitly
				// archive.on('error', function(err) {
				//   throw err;
				// });
 
				// // pipe archive data to the file
				// archive.pipe(zipfile);
				// archive.directory(siteDir, false);
				// archive.finalize();





				const dataString = JSON.stringify({
					status: (downloadedFiles.length ? 'success' : 'error'),
					//zipPath: zipfilepath,
					realPageURL : realPageURL,
					renderDifference : renderDifference,
					downloadedFiles: downloadedFiles
				}, null, '\t');


				// Write to the log fileb
				fs.writeFileSync(logDir+'browser.log', dataString);


				// JSON OUTPUT
				res.writeHead(200, {
					'content-type': 'application/json',
				});
				res.end(dataString);


				// SCREENSHOTS
				try {

					// Wait
					let waitMs = 2000;
					console.log('⏳ Waiting for '+ (waitMs/1000) +' seconds to take the screenshot...');
					await page.waitFor(waitMs);

					console.log('SCREENSHOTTING...');
					const screenshot = await pTimeout(page.screenshot({
						type: 'jpeg',
						clip: {
							x : 0,
							y : 0,
							width : width,
							height: height
						}
					}), 20 * 1000, 'Screenshot timed out');

					// Page Screenshot Saving
					const deviceScreenshotDir = siteDir + "screenshots/";
					const deviceScreenshot = deviceScreenshotDir + 'device-' + device_ID + '.jpg';
					if (!fs.existsSync(deviceScreenshotDir)) fs.mkdirSync(deviceScreenshotDir, { recursive: true });
					fs.writeFileSync(deviceScreenshot, screenshot);
					console.log('📸 Device Screenshot Saved: ', deviceScreenshot);


				} catch (err) {

					console.log('📷❌ Screenshots could not be saved: ', err);

				}


				break;
			}
			case 'screenshot': {


				// Screenshot status
				let screenshotSaved;


				// Device Screenshot Saving
				const deviceScreenshotDir = siteDir + "screenshots/";
				let deviceScreenshot = deviceScreenshotDir + 'device-' + device_ID + '.jpg';


				// Create folders
				if (!fs.existsSync(deviceScreenshotDir)) fs.mkdirSync(deviceScreenshotDir, { recursive: true });


				// SCREENSHOTS
				try {


					if (capture) {


						console.log('📸 Capturing the page...');
						const bodyHandle = await page.$('body');
						const bodySizes = await bodyHandle.boundingBox();
						await console.log('SIZES: ', bodySizes);
						const screenshot = await pTimeout(page.screenshot({
							type: 'jpeg',
							clip: {
								x : 0,
								y : 0,
								width : bodySizes.width,
								height: bodySizes.height
							}
						}), 20 * 1000, 'Screenshot timed out');
						fs.writeFileSync(deviceScreenshot, screenshot);
						await bodyHandle.dispose();


					} else {


						// Wait
						let waitMs = 2000;
						console.log('⏳ Waiting for '+ (waitMs/1000) +' seconds to take the device screenshot...');
						await page.waitFor(waitMs);


						console.log('📸 Getting device screenshot...');
						const screenshot = await pTimeout(page.screenshot({
							type: 'jpeg',
							clip: {
								x : 0,
								y : 0,
								width : width,
								height: height
							}
						}), 20 * 1000, 'Screenshot timed out');
						fs.writeFileSync(deviceScreenshot, screenshot);


					}


					console.log('📸 Device Screenshot Saved: ', deviceScreenshot);
					screenshotSaved = true;


				} catch (err) {

					console.log('📷❌ Screenshots could not be saved: ', err);
					screenshotSaved = false;

				}


				const dataString = JSON.stringify({
					status: (screenshotSaved ? 'success' : 'error'),
					screenshot : deviceScreenshot,
					page_type: page_type
				}, null, '\t');


				// JSON OUTPUT
				res.writeHead(200, {
					'content-type': 'application/json',
				});
				res.end(dataString);


				break;
			}
			case 'capture': {


				break;
			}
			case 'render': {
				const raw = queryData.raw || false;

				const content = await pTimeout(raw ? page.content() : page.evaluate(() => {
					let content = '';
					if (document.doctype) {
						content = new XMLSerializer().serializeToString(document.doctype);
					}

					const doc = document.documentElement.cloneNode(true);

					// Remove scripts except JSON-LD
					const scripts = doc.querySelectorAll('script:not([type="application/ld+json"])');
					scripts.forEach(s => s.parentNode.removeChild(s));

					// Remove import tags
					const imports = doc.querySelectorAll('link[rel=import]');
					imports.forEach(i => i.parentNode.removeChild(i));

					const { origin,	pathname } = location;
					// Inject <base> for loading relative resources
					if (!doc.querySelector('base')) {
						const base = document.createElement('base');
						base.href = origin + pathname;
						doc.querySelector('head').appendChild(base);
					}

					// Try to fix absolute paths
					const absEls = doc.querySelectorAll('link[href^="/"], script[src^="/"], img[src^="/"]');
					absEls.forEach(el => {
						const href = el.getAttribute('href');
						const src = el.getAttribute('src');
						if (src && /^\/[^/]/i.test(src)) {
							el.src = origin + src;
						} else if (href && /^\/[^/]/i.test(href)) {
							el.href = origin + href;
						}
					});

					content += doc.outerHTML;

					// Remove comments
					content = content.replace(/<!--[\s\S]*?-->/g, '');

					return content;
				}), 10 * 1000, 'Render timed out');

				res.writeHead(200, {
					'content-type': 'text/html; charset=UTF-8',
					'cache-control': 'public,max-age=31536000',
				});
				res.end(content);
				break;
			}
			case 'pdf': {
				const format = queryData.format || null;
				const pageRanges = queryData.pageRanges || null;

				const pdf = await pTimeout(page.pdf({
					format,
					pageRanges,
				}), 10 * 1000, 'PDF timed out');

				res.writeHead(200, {
					'content-type': 'application/pdf',
					'cache-control': 'public,max-age=31536000',
				});
				res.end(pdf, 'binary');
				break;
			}
			default: {

				const thumbWidth = parseInt(queryData.thumbWidth, 10) || null;
				const clipSelector = queryData.clipSelector;


				let screenshot;
				if (clipSelector) {
					const handle = await page.$(clipSelector);
					if (handle) {
						screenshot = await pTimeout(handle.screenshot({
							type: 'jpeg',
							clip: {
								x : 0,
								y : 0,
								width : width,
								height: height
							}
						}), 20 * 1000, 'Screenshot timed out');
					}
				} else {
					screenshot = await pTimeout(page.screenshot({
						type: 'jpeg',
						fullPage,
					}), 20 * 1000, 'Screenshot timed out');
				}


				res.writeHead(200, {
					'content-type': 'image/jpeg',
					'cache-control': 'public,max-age=31536000',
				});


				if (thumbWidth && thumbWidth < width) {

					const image = await jimp.read(screenshot);
					image.resize(thumbWidth, jimp.AUTO).quality(90).getBuffer(jimp.MIME_JPEG, (err, buffer) => {
						res.end(buffer, 'binary');
					});

				} else {

					res.end(screenshot, 'binary');

				}

			}
		}


		actionDone = true;
		console.log('💥 Done action: ' + action);
		console.log('💥 Download Type: ' + page_type);






		// Close the page
		try {

			if (page && page.close) {
				console.log('🗑 Tab closing for ' + url);
				page.removeAllListeners();
				page.close().then(buffer => {


					console.log('🗑✅ Tab closed for ' + url);


					if (browser[browser_ID]) {

						console.log('🔌 Closing the browser for ' + url, ' PROJECT ID: ' + project_ID, ' PAGE ID: ' + page_ID, ' PHASE ID: ' + phase_ID, ' DEVICE ID: ' + device_ID, 'BROWSER ID: ' + browser_ID);

						browser[browser_ID].close();
						browser[browser_ID] = null;
						delete browser[browser_ID];

						console.log('🔌✅ Browser closed for ' + url, ' PROJECT ID: ' + project_ID, ' PAGE ID: ' + page_ID, ' PHASE ID: ' + phase_ID, ' DEVICE ID: ' + device_ID, 'BROWSER ID: ' + browser_ID);

					}

				}, e => {
					console.error(`❌ Page Closing Failed (URL: ${url}): ${e}`);
				});


			}

		} catch (e) {

			console.log('🐞 Closing error: ' + e);

		}




		/*
			if (!cache.has(pageURL)) {
				cache.set(pageURL, page);

				// Try to stop all execution
				page.frames().forEach((frame) => {
					frame.evaluate(() => {
						// Clear all timer intervals https://stackoverflow.com/a/6843415/20838
						for (var i = 1; i < 99999; i++) window.clearInterval(i);
						// Disable all XHR requests
						XMLHttpRequest.prototype.send = _ => _;
						// Disable all RAFs
						requestAnimationFrame = _ => _;
					});
				});
			}

			if (!cache.has(pageURL + 'downloadableRequests')) {
				cache.set(pageURL + 'downloadableRequests', downloadableRequests);
			}
		*/




	} catch (e) {
		if (!DEBUG && page) {
			console.error(e);
			console.log('💔 Force close ' + pageURL);
			page.removeAllListeners();
			page.close();
		}
		//cache.del(pageURL);
		//cache.del(pageURL + 'downloadableRequests');
		const { message = '' } = e;
		res.writeHead(400, {
			'content-type': 'text/plain',
		});
		res.end('Oops. Something is wrong.\n\n' + message);

		// Handle websocket not opened error
		if (/not opened/i.test(message) && browser) {
			console.error('🕸 Web socket failed');
			try {

				for (var p_ID in browser) {
				    if (browser.hasOwnProperty(p_ID)) {

				        console.log(p_ID + " Browser Closing...");

				        browser[p_ID].close();
						browser[p_ID] = null;
						delete browser[p_ID];

				    }
				}

			} catch (err) {
				console.warn(`Chrome could not be killed ${err.message}`);
				browser = null;
			}
		}
	}

}).listen(PORT || 3000);

process.on('SIGINT', () => {
	if (browser) {

		for (var p_ID in browser) {
		    if (browser.hasOwnProperty(p_ID)) {

		        console.log(p_ID + " Browser Closing...");

		        browser[p_ID].close();
				browser[p_ID] = null;
				delete browser[p_ID];

		    }
		}

	}
	process.exit();
});

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at:', p, 'reason:', reason);
});
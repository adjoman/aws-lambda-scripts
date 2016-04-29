// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var gm = require('gm')
.subClass({ imageMagick: true }); // Enable ImageMagick integration.
var util = require('util');
var path = require('path');

// constants
var VERSIONS = [{width: 1080, height: 1080, dstSuffix: "-1080"}, {width: 200, height: 200, dstSuffix: "-200"}, {width: 100, height: 100, dstSuffix: "-100"}];

// get reference to S3 client
var s3 = new AWS.S3();

exports.handler = function(event, context, callback) {
	// Read options from the event.
	console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
	var srcBucket = event.Records[0].s3.bucket.name;
	// Object key may have spaces or unicode non-ASCII characters.
	var srcKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
	var dstBucket = "settlin";

	// Sanity check: validate that source and destination are different buckets.
	if (srcBucket == dstBucket) {
		callback("Source and destination buckets are the same.");
		return;
	}

	// Infer the image type.
	var typeMatch = srcKey.match(/\.([^.]*)$/);
	if (!typeMatch) {
		callback("Could not determine the image type.");
		return;
	}
	var imageType = typeMatch[1];
	if (imageType != "jpg" && imageType != "png") {
		callback('Unsupported image type: ${imageType}');
		return;
	}

	// Download the image from S3, transform, and upload to a different S3 bucket.
	async.waterfall([
		function download(next) {
			// Download the image from S3 into a buffer.
			s3.getObject({
				Bucket: srcBucket,
				Key: srcKey
			},
			next);
		},
		function transform(response, next) {
			gm(response.Body).size(function(err, size) {
				var self = this;

				var createVersion = function(versions, ind, buffers) {
					if (ind === versions.length) {
						next(null, response.contentType, buffers);
						return;
					}

					// Infer the scaling factor to avoid stretching the image unnaturally.
					var scalingFactor = Math.min(versions[ind].width / size.width, versions[ind].height / size.height);
					var width	= scalingFactor * size.width;
					var height = scalingFactor * size.height;

					self.resize(width, height).toBuffer(imageType, function(err, buffer) {
						if (err) next(err);
						else {
							buffers.push(buffer);
							createVersion(versions, ind + 1, buffers);
						}
					});
				}

				// Transform the image buffer in memory.
				var buffers = [];
				createVersion(VERSIONS, 0, buffers);
			});
		},
		function upload(contentType, buffers, next) {
			// Stream the transformed image to a different S3 bucket.
			var putFile = function(versions, ind) {
				if (ind === versions.length - 1) cb = next;
				else cb = function() { putFile(versions, ind + 1); };

				s3.putObject({
					Bucket: dstBucket,
					Key: path.dirname(srcKey) + versions[ind].dstSuffix + "/" + path.basename(srcKey),
					Body: buffers[ind],
					ContentType: contentType
				}, cb);
			};

			putFile(VERSIONS, 0);
		}
	], function (err) {
		if (err) {
			console.error(
				'Unable to resize ' + srcBucket + '/' + srcKey +
				' and upload to ' + dstBucket + '/' + srcKey +
				' due to an error: ' + err
			);
		} else {
			console.log(
				'Successfully resized ' + srcBucket + '/' + srcKey +
				' and uploaded to ' + dstBucket + '/' + srcKey
			);
		}

		callback(null, "message");
	}
);
};
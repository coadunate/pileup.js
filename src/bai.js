/**
 * Tools for working with indexed BAM (BAI) files.
 * These have nothing to say about parsing the BAM file itself. For that, see
 * bam.js.
 * @flow
 */
'use strict';

import type * as RemoteFile from './RemoteFile';
import type * as ContigInterval from './ContigInterval';
import type * as Q from 'q';
import type * as VirtualOffset from './VirtualOffset';

var bamTypes = require('./formats/bamTypes');
var jBinary = require('jbinary');
var jDataView = require('jdataview');
var _ = require('underscore');


// In the event that index chunks aren't available from an external source, it
// winds up saving time to do a fast pass over the data to compute them. This
// allows us to parse a single contig at a time using jBinary.
function computeIndexChunks(buffer) {
  var view = new jDataView(buffer, 0, buffer.byteLength, true /* little endian */);

  var contigStartOffsets = [];
  view.getInt32();  // magic
  var n_ref = view.getInt32();
  for (var j = 0; j < n_ref; j++) {
    contigStartOffsets.push(view.tell());
    var n_bin = view.getInt32();
    for (var i = 0; i < n_bin; i++) {
      view.getUint32();  // bin ID
      var n_chunk = view.getInt32();
      view.skip(n_chunk * 16);
    }
    var n_intv = view.getInt32();
    view.skip(n_intv * 8);
  }
  contigStartOffsets.push(view.tell());

  return {
    chunks: _.zip(_.initial(contigStartOffsets), _.rest(contigStartOffsets)),
    minBlockIndex: 0  // TODO: compute this, it tightens the initial header request
  };
}


function readChunks(buf) {
  return new jBinary(buf, bamTypes.TYPE_SET).read('ChunksArray');
}

function readIntervals(buf) {
  return new jBinary(buf, bamTypes.TYPE_SET).read('IntervalsArray');
}

type Chunk = {
  chunk_beg: VirtualOffset;
  chunk_end: VirtualOffset;
}

function doChunksOverlap(a: Chunk, b: Chunk) {
  return a.chunk_beg.isLessThanOrEqual(b.chunk_end) &&
         b.chunk_beg.isLessThanOrEqual(a.chunk_end);
}

function areChunksAdjacent(a: Chunk, b: Chunk) {
  return a.chunk_beg.isEqual(b.chunk_end) || a.chunk_end.isEqual(b.chunk_beg);
}

// This coalesces adjacent & overlapping chunks to minimize fetches.
// It also applies the "linear optimization", which can greatly reduce the
// number of network fetches needed to fulfill a request.
function optimizeChunkList(chunkList: Chunk[], minimumOffset: VirtualOffset): Chunk[] {
  chunkList.sort((a, b) => {
    var result = a.chunk_beg.compareTo(b.chunk_beg);
    if (result === 0) {
      result = a.chunk_end.compareTo(b.chunk_end);
    }
    return result;
  });

  var newChunks = [];
  chunkList.forEach(chunk => {
    if (chunk.chunk_end.isLessThan(minimumOffset)) {
      return;  // linear index optimization
    }

    if (newChunks.length === 0) {
      newChunks.push(chunk);
      return;
    }

    var lastChunk = newChunks[newChunks.length - 1];
    if (!doChunksOverlap(lastChunk, chunk) &&
        !areChunksAdjacent(lastChunk, chunk)) {
      newChunks.push(chunk);
    } else {
      if (lastChunk.chunk_end.isLessThan(chunk.chunk_end)) {
        lastChunk.chunk_end = chunk.chunk_end;
      }
    }
  });

  return newChunks;
}

class ImmediateBaiFile {
  buffer: ArrayBuffer;
  indexChunks: Object;

  constructor(buffer: ArrayBuffer) {
    this.buffer = buffer;
    this.indexChunks = computeIndexChunks(buffer);
  }

  getChunksForInterval(range: ContigInterval<number>): Chunk[] {
    if (range.contig < 0 || range.contig > this.indexChunks.chunks.length) {
      throw `Invalid contig ${range.contig}`;
    }

    var bins = reg2bins(range.start(), range.stop() + 1);

    var contigIndex = this.indexForContig(range.contig);

    var chunks = _.chain(contigIndex.bins)
                  .filter(b => bins.indexOf(b.bin) >= 0)
                  .map(b => readChunks(b.chunks))
                  .flatten()
                  .value();

    var linearIndex = readIntervals(contigIndex.intervals);
    var startIdx = Math.max(0, Math.floor(range.start() / 16384));
    var minimumOffset = linearIndex[startIdx];

    chunks = optimizeChunkList(chunks, minimumOffset);

    return chunks;
  }

  // Retrieve and parse the index for a particular contig.
  // TODO: make this async
  indexForContig(contig: number): Object {
    var [start, stop] = this.indexChunks.chunks[contig];
    var jb = new jBinary(this.buffer.slice(start, stop), bamTypes.TYPE_SET);
    return jb.read('BaiIndex');
  }
}


class BaiFile {
  remoteFile: RemoteFile;
  immediate: Q.Promise<ImmediateBaiFile>;

  constructor(remoteFile: RemoteFile) {
    this.remoteFile = remoteFile;
    this.immediate = remoteFile.getAll().then(buf => {
      return new ImmediateBaiFile(buf);
    });
    this.immediate.done();
  }

  getChunksForInterval(range: ContigInterval<number>): Q.Promise<Chunk[]> {
    return this.immediate.then(immediate => {
      return immediate.getChunksForInterval(range);
    });
  }
}


// These functions come directly from the SAM paper
// See https://samtools.github.io/hts-specs/SAMv1.pdf section 5.3

// calculate the list of bins that may overlap with region [beg,end) (zero-based)
function reg2bins(beg, end) {
  var k, list = [];
  --end;
  list.push(0);
  for (k =    1 + (beg>>26); k <=    1 + (end>>26); ++k) list.push(k);
  for (k =    9 + (beg>>23); k <=    9 + (end>>23); ++k) list.push(k);
  for (k =   73 + (beg>>20); k <=   73 + (end>>20); ++k) list.push(k);
  for (k =  585 + (beg>>17); k <=  585 + (end>>17); ++k) list.push(k);
  for (k = 4681 + (beg>>14); k <= 4681 + (end>>14); ++k) list.push(k);
  return list;
}

module.exports = BaiFile;
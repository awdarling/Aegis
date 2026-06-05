import type { Request, Response, NextFunction } from 'express';
import { Readable } from 'stream';

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

// Buffer the request body into req.rawBody, then splice in a fresh
// readable stream so downstream parsers (multer in particular) can still
// read it. ECDSA signature verification requires the EXACT raw bytes the
// sender signed, so this must run before any body parser that mutates or
// consumes the stream.
//
// Scope this to routes that need it — it loads the whole body into memory.
export function captureRawBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.rawBody) {
    next();
    return;
  }

  const chunks: Buffer[] = [];
  let done = false;

  const onData = (chunk: Buffer): void => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  const onEnd = (): void => {
    if (done) return;
    done = true;
    req.rawBody = Buffer.concat(chunks);

    // Multer reads the body via req.pipe(busboy). The original stream is
    // now drained, so rebind the stream methods to a fresh Readable backed
    // by the buffer we just captured.
    const replay = Readable.from(req.rawBody);
    (req as unknown as { pipe: Readable['pipe'] }).pipe = replay.pipe.bind(replay);
    (req as unknown as { unpipe: Readable['unpipe'] }).unpipe = replay.unpipe.bind(replay);
    (req as unknown as { read: Readable['read'] }).read = replay.read.bind(replay);

    next();
  };
  const onError = (err: Error): void => {
    if (done) return;
    done = true;
    next(err);
  };

  req.on('data', onData);
  req.once('end', onEnd);
  req.once('error', onError);
}

export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Authenticated user has no channel');
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor(contentType: string) {
    super(
      'UNSUPPORTED_VIDEO_TYPE',
      400,
      `Content type is not an accepted video format: ${contentType}`,
    );
  }
}

export class FileTooLargeException extends DomainException {
  constructor(maxBytes: number) {
    super(
      'FILE_TOO_LARGE',
      400,
      `File exceeds the maximum allowed size of ${maxBytes} bytes`,
    );
  }
}

export class UploadNotInProgressException extends DomainException {
  constructor() {
    super(
      'UPLOAD_NOT_IN_PROGRESS',
      409,
      'Video has no multipart upload in progress',
    );
  }
}

export class UploadIncompleteException extends DomainException {
  constructor(expected: number, stored: number) {
    super(
      'UPLOAD_INCOMPLETE',
      409,
      `Upload is incomplete: ${stored} of ${expected} parts stored`,
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video has not finished processing');
  }
}

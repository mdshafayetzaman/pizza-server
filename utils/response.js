export function sendError(res, status, message, details) {
  const payload = {
    success: false,
    message,
  }
  if (details !== undefined) payload.details = details
  return res.status(status).send(payload)
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

export const loginCodeTemplate = (name: string, code: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Your Login Code</title>
</head>
<body>
  <p>Hi ${name},</p>

  <p>Your login code is:</p>
  <h2>${code}</h2>
  <p>This code will expire in 10 minutes.</p>

  <hr />

  <p>
    <a href="https://dployr.dev">dployr.dev</a><br>
    <i>Your app, your server, your rules!</i>
  </p>

  <p><small>This email is from an unattended mailbox and cannot receive replies.</small></p>
</body>
</html>
`;

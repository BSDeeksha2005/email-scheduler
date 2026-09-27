import nodemailer, { Transporter } from "nodemailer";

let transporterPromise: Promise<Transporter> | null = null;

export function getTransporter(): Promise<Transporter> {
  if (transporterPromise) return transporterPromise;

  transporterPromise = (async () => {
    let user = process.env.ETHEREAL_USER;
    let pass = process.env.ETHEREAL_PASS;

    if (!user || !pass) {
      // Auto-create a disposable Ethereal test account if none provided.
      const testAccount = await nodemailer.createTestAccount();
      user = testAccount.user;
      pass = testAccount.pass;
      console.log(`[mailer] Created Ethereal test account: ${user}`);
    }

    return nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user, pass },
    });
  })();

  return transporterPromise;
}

'use client';

import { useState } from 'react';
import { Button } from '@/components/button';
import { Input } from '@/components/input';

export default function QRGeneratorPage() {
  const [token, setToken] = useState('');
  const [qrUrl, setQrUrl] = useState('');

  const generateToken = () => {
    const newToken = Math.random().toString(36).substring(2, 12);
    setToken(newToken);
    setQrUrl(`/api/qr/generate?token=${newToken}`);
  };

  const downloadQR = () => {
    if (qrUrl) {
      const link = document.createElement('a');
      link.href = qrUrl;
      link.download = `qr-${token}.png`;
      link.click();
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        QR Code Generator
      </h1>

      <div className="bg-white rounded-lg shadow p-6 space-y-6">
        <div>
          <p className="text-gray-600 mb-4">
            Generate QR codes for appliance registration. Each QR code links to a unique token.
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex gap-3">
            <Input
              label="Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter token or generate new"
              className="flex-1"
            />
            <div className="flex items-end">
              <Button onClick={generateToken}>
                Generate Token
              </Button>
            </div>
          </div>

          {token && (
            <>
              <Button
                fullWidth
                variant="outline"
                onClick={() => setQrUrl(`/api/qr/generate?token=${token}`)}
              >
                Create QR Code
              </Button>

              {qrUrl && (
                <div className="border-t pt-6">
                  <div className="text-center">
                    <img
                      src={qrUrl}
                      alt="QR Code"
                      className="mx-auto mb-4 border-2 border-gray-200 rounded"
                    />
                    <p className="text-sm text-gray-600 mb-4">
                      Scan URL: {process.env.NEXT_PUBLIC_BASE_URL || 'https://fixready.imajin.ai'}/go/{token}
                    </p>
                    <Button onClick={downloadQR} variant="secondary">
                      Download QR Code
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded p-4 text-sm text-gray-700">
          <p className="font-medium mb-1">Usage:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Generate a new token or enter a custom one</li>
            <li>Create the QR code</li>
            <li>Download and print on magnets or labels</li>
            <li>Customers scan to register their appliances</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

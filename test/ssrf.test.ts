import { describe, expect, it } from 'vitest';
import { publicAddressPolicy } from '../src/net/ssrf.js';

const BLOCKED: readonly string[] = [
  // IPv4
  '0.0.0.0',
  '10.0.0.1',
  '10.255.255.255',
  '100.64.0.1',
  '100.127.255.255',
  '127.0.0.1',
  '127.255.255.254',
  '169.254.169.254', // cloud metadata
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.2.1',
  '192.168.0.1',
  '192.168.255.255',
  '198.18.0.1',
  '198.51.100.7',
  '203.0.113.9',
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
  // IPv6
  '::',
  '::1',
  'fe80::1',
  'fe80::1%en0',
  'febf::1',
  'fc00::1',
  'fd12:3456:789a::1',
  'ff02::1',
  '2001:db8::1',
  // IPv4-mapped / NAT64 with embedded private v4
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  '64:ff9b::7f00:1', // embeds 127.0.0.1
];

const ALLOWED: readonly string[] = [
  '1.1.1.1',
  '8.8.8.8',
  '9.255.255.255',
  '11.0.0.1',
  '100.63.255.255',
  '100.128.0.1',
  '126.255.255.255',
  '128.0.0.1',
  '169.253.255.255',
  '169.255.0.1',
  '172.15.255.255',
  '172.32.0.1',
  '192.167.255.255',
  '192.169.0.1',
  '198.17.255.255',
  '198.20.0.1',
  '223.255.255.255',
  '2001:4860:4860::8888',
  '2600:1901::1',
  '::ffff:8.8.8.8',
  '64:ff9b::808:808', // embeds 8.8.8.8 (public NAT64 target)
];

describe('publicAddressPolicy', () => {
  it.each(BLOCKED.map((a) => [a]))('blocks %s', (address) => {
    expect(publicAddressPolicy.check(address)).not.toBeNull();
  });

  it.each(ALLOWED.map((a) => [a]))('allows %s', (address) => {
    expect(publicAddressPolicy.check(address)).toBeNull();
  });

  it('rejects things that are not IP addresses', () => {
    expect(publicAddressPolicy.check('example.com')).not.toBeNull();
    expect(publicAddressPolicy.check('')).not.toBeNull();
    expect(publicAddressPolicy.check('999.1.1.1')).not.toBeNull();
  });
});

import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChargeTokenDto, StoreCardDto } from './payment-orders.controller';
import { netpayText } from './netpay-endpoints';

/** Browser data every charge carries. */
const DEVICE = {
  deviceFingerPrint: 'fp_0123456789abcdef',
  deviceInformation: {
    deviceChannel: 'Browser',
    httpBrowserColorDepth: '24',
    httpBrowserJavaEnabled: 'FALSE',
    httpBrowserJavaScriptEnabled: 'TRUE',
    httpBrowserLanguage: 'es',
    httpBrowserScreenHeight: '687',
    httpBrowserScreenWidth: '1718',
    httpBrowserTimeDifference: '360',
  },
};

const BILLING = {
  firstName: 'Ana',
  lastName: 'Lopez',
  email: 'accept@netpay.com.mx',
  phone: '8123478321',
  address: {
    city: 'Monterrey',
    country: 'MX',
    postalCode: '64700',
    state: 'NLE',
    street1: 'Filosofos 100',
    street2: 'Tecnologico',
  },
};

/**
 * Validates a charge body and returns the properties that failed.
 *
 * @param patch Changes applied over a valid body.
 * @returns Dotted paths of the failing properties.
 */
async function failing(patch: (b: typeof BILLING) => unknown): Promise<string[]> {
  const billing = structuredClone(BILLING);
  const body = { cardToken: 'token_abcdefghij', ...DEVICE, billing: patch(billing) ?? billing };
  const errors = await validate(plainToInstance(ChargeTokenDto, body));
  const paths: string[] = [];
  const walk = (list: typeof errors, prefix: string): void => {
    for (const e of list) {
      const path = prefix === '' ? e.property : `${prefix}.${e.property}`;
      if (e.constraints !== undefined) {
        paths.push(path);
      }
      walk(e.children ?? [], path);
    }
  };
  walk(errors, '');
  return paths;
}

describe('Netpay certification: field rules', () => {
  it('accepts the documented example payload', async () => {
    expect(await failing(() => undefined)).toEqual([]);
  });

  it.each(['55 1234 5678', '+5255123456', '55-1234', 'abc1234567', '1234567890<'])(
    'refuses a phone with anything but digits: %s',
    async (phone) => {
      expect(await failing((b) => ({ ...b, phone }))).toContain('billing.phone');
    },
  );

  it.each(['6470A', '64 700', '64700-1'])(
    'refuses a postal code with anything but digits: %s',
    async (code) => {
      expect(await failing((b) => ({ ...b, address: { ...b.address, postalCode: code } }))).toContain(
        'billing.address.postalCode',
      );
    },
  );

  it('accepts the characters real addresses carry; they are filtered, not refused', async () => {
    expect(
      await failing((b) => ({
        ...b,
        firstName: 'José María',
        lastName: "O'Connor-Peña",
        address: { ...b.address, street1: 'Calle 5 #12 S/N', street2: 'Col. Centro, Sur' },
      })),
    ).toEqual([]);
  });

  it.each(['mx', 'MEX', 'M', '1X'])('refuses a country that is not ISO alpha-2: %s', async (country) => {
    expect(await failing((b) => ({ ...b, address: { ...b.address, country } }))).toContain(
      'billing.address.country',
    );
  });

  it.each(['MX-NLE', 'nle', 'N', 'NLEX'])(
    'refuses a state that is not the bare ISO 3166-2 segment: %s',
    async (state) => {
      expect(await failing((b) => ({ ...b, address: { ...b.address, state } }))).toContain(
        'billing.address.state',
      );
    },
  );

  it.each(['NLE', 'CMX', 'JAL', 'NL'])('accepts the state segment %s', async (state) => {
    expect(await failing((b) => ({ ...b, address: { ...b.address, state } }))).toEqual([]);
  });

  it('applies the digits rule to a stored customer too', async () => {
    const card = await validate(
      plainToInstance(StoreCardDto, {
        identifier: 'buyer/1',
        firstName: 'Ana',
        lastName: 'Lopez',
        email: 'a@b.mx',
        phone: '55 1234',
      }),
    );
    expect(card.map((e) => e.property)).toEqual(['phone']);
  });
});

describe('Netpay certification: text filtering', () => {
  it.each(['!', '#', '$', '%', '&', '*', '<', '>', '?', '/', '\\'])('filters %s out', (char) => {
    expect(netpayText(`Calle${char}5`)).toBe('Calle 5');
  });

  it('filters control characters and collapses the spacing it leaves', () => {
    expect(netpayText('  Calle 5 #12\u0000\n S/N  ')).toBe('Calle 5 12 S N');
  });

  it('strips accents (OXXO Pay refuses "Díaz") but keeps dots, commas, hyphens and apostrophes', () => {
    expect(netpayText("José O'Connor-Peña, Col. Centro")).toBe("Jose O'Connor-Pena, Col. Centro");
    expect(netpayText('Rosa Díaz Muñoz')).toBe('Rosa Diaz Munoz');
  });
});

import { User, UserRole } from '@logto/schemas';
import { adminConsoleApplicationId } from '@logto/schemas/lib/seeds';
import { Provider } from 'oidc-provider';

import { mockUser } from '@/__mocks__';
import RequestError from '@/errors/RequestError';
import { createRequester } from '@/utils/test-utils';

import usernamePasswordRoutes, {
  registerRoute,
  signInRoute,
  reAuthRoute,
} from './username-password';

const insertUser = jest.fn(async (..._args: unknown[]) => ({ id: 'id' }));
const findUserById = jest.fn(async (): Promise<User> => mockUser);
const updateUserById = jest.fn(async (..._args: unknown[]) => ({ id: 'id' }));
const hasActiveUsers = jest.fn(async () => true);

jest.mock('@/queries/user', () => ({
  findUserById: async () => findUserById(),
  findUserByIdentity: async () => ({ id: 'id', identities: {} }),
  findUserByPhone: async () => ({ id: 'id' }),
  findUserByEmail: async () => ({ id: 'id' }),
  updateUserById: async (...args: unknown[]) => updateUserById(...args),
  hasUser: async (username: string) => username === 'username1',
  hasUserWithIdentity: async (connectorId: string, userId: string) =>
    connectorId === 'connectorId' && userId === 'id',
  hasUserWithPhone: async (phone: string) => phone === '13000000000',
  hasUserWithEmail: async (email: string) => email === 'a@a.com',
  hasActiveUsers: async () => hasActiveUsers(),
}));

jest.mock('@/lib/user', () => ({
  async findUserByUsernameAndPassword(username: string, password: string) {
    if (username !== 'foo' && username !== 'admin') {
      throw new RequestError('session.invalid_credentials');
    }

    if (password !== 'password') {
      throw new RequestError('session.invalid_credentials');
    }

    const roleNames = username === 'admin' ? [UserRole.Admin] : [];

    return { id: 'user1', roleNames };
  },
  generateUserId: () => 'user1',
  encryptUserPassword: (password: string) => ({
    passwordEncrypted: password + '_user1',
    passwordEncryptionMethod: 'Argon2i',
  }),
  updateLastSignInAt: async (...args: unknown[]) => updateUserById(...args),
  insertUser: async (...args: unknown[]) => insertUser(...args),
}));

const grantSave = jest.fn(async () => 'finalGrantId');
const grantAddOIDCScope = jest.fn();
const grantAddResourceScope = jest.fn();
const interactionResult = jest.fn(async () => 'redirectTo');
const interactionDetails: jest.MockedFunction<() => Promise<unknown>> = jest.fn(async () => ({}));

class Grant {
  static async find(id: string) {
    return id === 'exists' ? new Grant() : undefined;
  }

  save: typeof grantSave;
  addOIDCScope: typeof grantAddOIDCScope;
  addResourceScope: typeof grantAddResourceScope;

  constructor() {
    this.save = grantSave;
    this.addOIDCScope = grantAddOIDCScope;
    this.addResourceScope = grantAddResourceScope;
  }
}

jest.mock('oidc-provider', () => ({
  Provider: jest.fn(() => ({
    Grant,
    interactionDetails,
    interactionResult,
  })),
}));

afterEach(() => {
  grantSave.mockClear();
  interactionResult.mockClear();
});

describe('sessionRoutes', () => {
  const sessionRequest = createRequester({
    anonymousRoutes: usernamePasswordRoutes,
    provider: new Provider(''),
    middlewares: [
      async (ctx, next) => {
        ctx.addLogContext = jest.fn();
        ctx.log = jest.fn();

        return next();
      },
    ],
  });

  describe('POST /session/sign-in/username-password', () => {
    it('assign result and redirect', async () => {
      interactionDetails.mockResolvedValueOnce({ params: {} });
      const response = await sessionRequest.post(signInRoute).send({
        username: 'foo',
        password: 'password',
      });
      expect(response.statusCode).toEqual(200);
      expect(response.body).toHaveProperty('redirectTo');
      expect(interactionResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ login: expect.objectContaining({ accountId: 'user1' }) }),
        expect.anything()
      );
    });

    it('throw if user not found', async () => {
      interactionDetails.mockResolvedValueOnce({ params: {} });
      const response = await sessionRequest.post(signInRoute).send({
        username: 'notexistuser',
        password: 'password',
      });
      expect(response.statusCode).toEqual(400);
    });

    it('throw if user found but wrong password', async () => {
      interactionDetails.mockResolvedValueOnce({ params: {} });
      const response = await sessionRequest.post(signInRoute).send({
        username: 'foo',
        password: '_password',
      });
      expect(response.statusCode).toEqual(400);
    });

    it('throw if non-admin user sign in to AC', async () => {
      interactionDetails.mockResolvedValueOnce({
        params: { client_id: adminConsoleApplicationId },
      });
      const response = await sessionRequest.post(signInRoute).send({
        username: 'foo',
        password: 'password',
      });

      expect(response.statusCode).toEqual(403);
      console.log(response);
    });

    it('should throw if admin user sign in to AC', async () => {
      interactionDetails.mockResolvedValueOnce({
        params: { client_id: adminConsoleApplicationId },
      });
      const response = await sessionRequest.post(signInRoute).send({
        username: 'admin',
        password: 'password',
      });

      expect(response.statusCode).toEqual(200);
    });
  });

  describe('POST /session/register/username-password', () => {
    it('assign result and redirect', async () => {
      interactionDetails.mockResolvedValueOnce({ params: {} });

      const response = await sessionRequest
        .post(registerRoute)
        .send({ username: 'foo', password: 'password' });
      expect(insertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'user1',
          username: 'foo',
          passwordEncrypted: 'password_user1',
          passwordEncryptionMethod: 'Argon2i',
          roleNames: [],
        })
      );
      expect(response.body).toHaveProperty('redirectTo');
      expect(interactionResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ login: expect.objectContaining({ accountId: 'user1' }) }),
        expect.anything()
      );
    });

    it('register user with admin role for admin console if no active user found', async () => {
      interactionDetails.mockResolvedValueOnce({
        params: { client_id: adminConsoleApplicationId },
      });

      hasActiveUsers.mockResolvedValueOnce(false);

      await sessionRequest.post(registerRoute).send({ username: 'foo', password: 'password' });

      expect(insertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          roleNames: ['admin'],
        })
      );
    });

    it('should not register user with admin role for admin console if any active user found', async () => {
      interactionDetails.mockResolvedValueOnce({
        params: { client_id: adminConsoleApplicationId },
      });

      await sessionRequest.post(registerRoute).send({ username: 'foo', password: 'password' });

      expect(insertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          roleNames: [],
        })
      );
    });

    it('throw error if username not valid', async () => {
      const usernameStartedWithNumber = '1username';
      const response = await sessionRequest
        .post(registerRoute)
        .send({ username: usernameStartedWithNumber, password: 'password' });
      expect(response.statusCode).toEqual(400);
    });

    it('throw error if username exists', async () => {
      const response = await sessionRequest
        .post(registerRoute)
        .send({ username: 'username1', password: 'password' });
      expect(response.statusCode).toEqual(422);
    });
  });

  describe('POST /session/re-auth/username-password', () => {
    it('should update login.ts', async () => {
      interactionDetails.mockResolvedValue({
        params: {},
        result: { login: { accountId: 'foo', ts: 0 } },
      });
      const response = await sessionRequest.post(reAuthRoute).send({
        password: 'password',
      });
      expect(response.statusCode).toEqual(200);
      expect(response.body).toHaveProperty('ts');
      expect(response.body.ts).toBeGreaterThan(0);
      expect(interactionResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        expect.objectContaining({ login: expect.objectContaining({ ts: expect.anything() }) }),
        expect.anything()
      );
    });

    it('should throw if the password is wrong', async () => {
      interactionDetails.mockResolvedValue({
        params: {},
        result: { login: { accountId: 'foo', ts: 0 } },
      });
      const response = await sessionRequest.post(reAuthRoute).send({
        password: '_password',
      });
      expect(response.statusCode).toEqual(400);
    });

    it('should throw if current session is not authenticated before', async () => {
      interactionDetails.mockResolvedValue({ params: {} });
      const response = await sessionRequest.post(reAuthRoute).send({
        password: 'password',
      });
      expect(response.statusCode).toEqual(401);
    });
  });
});

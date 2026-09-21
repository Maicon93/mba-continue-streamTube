import { DataSource } from 'typeorm';
import { ChannelsService } from './channels.service';
import { Channel } from './entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';

describe('ChannelsService.findByUserId (integration)', () => {
  let dataSource: DataSource;
  let service: ChannelsService;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel]);
    await dataSource.initialize();
    service = new ChannelsService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM channels');
    await dataSource.query('DELETE FROM users');
  });

  const createUser = async (email: string): Promise<User> =>
    dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email,
        password: 'hash',
        is_confirmed: true,
      }),
    );

  it('should return the channel owned by the user', async () => {
    const user = await createUser('owner@streamtube.test');
    const created = await service.createChannel(user.id, user.email);

    const found = await service.findByUserId(user.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.nickname).toBe('owner');
  });

  it('should return null for a user that owns no channel', async () => {
    const user = await createUser('channelless@streamtube.test');

    await expect(service.findByUserId(user.id)).resolves.toBeNull();
  });

  it('should not return another user channel', async () => {
    const owner = await createUser('first@streamtube.test');
    const other = await createUser('second@streamtube.test');
    await service.createChannel(owner.id, owner.email);
    const otherChannel = await service.createChannel(other.id, other.email);

    const found = await service.findByUserId(other.id);

    expect(found!.id).toBe(otherChannel.id);
    expect(found!.user_id).toBe(other.id);
  });
});

import { Kitchen } from '../wrappers/Kitchen';
import { Blockchain, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, toNano } from '@ton/core';
import { TonMasterChef, PoolInfo } from '../wrappers/TonMasterChef';
import { MiniChef } from '../wrappers/MiniChef';
import { JettonWalletUSDT } from '../wrappers/JettonWallet';
import { JettonMasterUSDT } from '../wrappers/JettonMaster';
import '@ton/test-utils';

describe('MasterChef', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let thunderMint: SandboxContract<TreasuryContract>; // ThunderMint is the dev team to receive the fees in ton
    let masterChef: SandboxContract<TonMasterChef>;
    let usdt: SandboxContract<JettonMasterUSDT>;
    let masterChefJettonWallet: SandboxContract<JettonWalletUSDT>;
    let deployerJettonWallet: SandboxContract<JettonWalletUSDT>;
    let thunderMintJettonWallet: SandboxContract<JettonWalletUSDT>; // ThunderMint is the dev team to receive the fee in jetton
    let kitchen: SandboxContract<Kitchen>;
    let rewardPerSecond: bigint;
    let seed: bigint;
    let deadline: bigint;
    let totalReward: bigint;
    let masterChefJettonWalletAddress: Address;
    const fee = toNano('0.074'); // This fee is for STORAGE_FEE and GAS_FEE and THUNDERMINT_FEE

    // User deposits USDT to MasterChef by send JettonTransfer to his JettonWallet
    async function depositJetton(
        usdt: SandboxContract<JettonMasterUSDT>,
        user: SandboxContract<TreasuryContract>,
        masterChef: SandboxContract<TonMasterChef>,
        amount: bigint,
    ) {
        await usdt.send(user.getSender(), { value: toNano('1') }, 'Mint:1');
        const userJettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(user.address, usdt.address));
        return await userJettonWallet.send(
            user.getSender(),
            { value: toNano('1.1') },
            {
                $$type: 'JettonTransfer',
                query_id: 0n,
                amount: amount,
                destination: masterChef.address,
                response_destination: user.address,
                custom_payload: null,
                forward_ton_amount: toNano('1'),
                forward_payload: beginCell().endCell(),
            },
        );
    }

    // Add a pool to MasterChef
    async function addPool(
        masterChef: SandboxContract<TonMasterChef>,
        masterChefJettonWallet: SandboxContract<JettonWalletUSDT>,
        allocPoint = 100n,
    ) {
        return await masterChef.send(
            deployer.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'AddPool',
                lpTokenAddress: masterChefJettonWallet.address,
                allocPoint: allocPoint,
            },
        );
    }

    // Owner of MasterChef deposits reward token first, then user deposits USDT
    async function deposit(
        masterChef: SandboxContract<TonMasterChef>,
        user: SandboxContract<TreasuryContract>,
        masterChefJettonWallet: SandboxContract<JettonWalletUSDT>,
        usdt: SandboxContract<JettonMasterUSDT>,
        userDepositAmount = 1n * 10n ** 6n,
    ) {
        await addPool(masterChef, masterChefJettonWallet);
        return await depositJetton(usdt, user, masterChef, userDepositAmount);
    }

    // User withdraws USDT from MasterChef
    async function withdraw(
        masterChef: SandboxContract<TonMasterChef>,
        user: SandboxContract<TreasuryContract>,
        masterChefJettonWallet: SandboxContract<JettonWalletUSDT>,
        userWithdrawAmount = 5n * 10n ** 5n,
    ) {
        return await masterChef.send(
            user.getSender(),
            { value: toNano('1') },
            {
                $$type: 'Withdraw',
                queryId: 0n,
                lpTokenAddress: masterChefJettonWallet.address,
                amount: userWithdrawAmount,
                beneficiary: user.address,
            },
        );
    }

    // User harvests reward from MasterChef
    async function harvest(
        masterChef: SandboxContract<TonMasterChef>,
        user: SandboxContract<TreasuryContract>,
        masterChefJettonWallet: SandboxContract<JettonWalletUSDT>,
    ) {
        return await masterChef.send(
            user.getSender(),
            { value: toNano('1') },
            {
                $$type: 'Harvest',
                queryId: 0n,
                lpTokenAddress: masterChefJettonWallet.address,
                beneficiary: user.address,
            },
        );
    }

    beforeEach(async () => {
        // Init the blockchain
        blockchain = await Blockchain.create();
        blockchain.now = Math.floor(Date.now() / 1000);

        // Characters
        deployer = await blockchain.treasury('deployer'); // Owner of MasterChef
        user = await blockchain.treasury('user'); // User who deposits, withdraws, and harvests
        thunderMint = await blockchain.treasury('thunderMint'); // Dev team who receives the fees

        // Contracts
        kitchen = await blockchain.openContract(await Kitchen.fromInit(deployer.address, 0n)); // MasterChef Factory
        usdt = blockchain.openContract(await JettonMasterUSDT.fromInit(deployer.address, beginCell().endCell())); // Reward token and LP token
        seed = BigInt(`0x${beginCell().storeUint(Date.now(), 64).endCell().hash().toString('hex')}`); // Seed for MasterChef

        deployerJettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(deployer.address, usdt.address)); // Deployer USDT JettonWallet
        thunderMintJettonWallet = blockchain.openContract(
            await JettonWalletUSDT.fromInit(thunderMint.address, usdt.address),
        ); // ThunderMint USDT JettonWallet

        // Setup all the contracts
        await usdt.send(deployer.getSender(), { value: toNano('1') }, 'Mint:1'); // Mint USDT to deployer so that he can start the MasterChef
        const kitcherResult = await kitchen.send(
            deployer.getSender(),
            {
                value: toNano('0.5'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        expect(kitcherResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: kitchen.address,
            deploy: true,
            success: true,
        });

        let masterChefAddress = await kitchen.getGetTonMasterChefAddress(deployer.address, seed); // MasterChef address
        masterChef = blockchain.openContract(await TonMasterChef.fromAddress(masterChefAddress)); // MasterChef
        masterChefJettonWalletAddress = await usdt.getGetWalletAddress(masterChefAddress); // MasterChef USDT JettonWallet address
        masterChefJettonWallet = blockchain.openContract(
            await JettonWalletUSDT.fromAddress(masterChefJettonWalletAddress),
        ); // MasterChef USDT JettonWallet

        deadline = BigInt(blockchain.now!! + 2000);
        totalReward = toNano('10');
        let sendingTon = (totalReward * 1003n) / 1000n + toNano('1');
        // Build the MasterChef contract from kitchen
        const masterChefResult = await kitchen.send(
            deployer.getSender(),
            {
                value: sendingTon,
            },
            {
                $$type: 'BuildTonMasterChef',
                owner: deployer.address,
                seed: seed,
                thunderMintWallet: thunderMint.address,
                metaData: beginCell().storeStringTail('httpppp').endCell(),
                deadline: deadline,
                totalReward: totalReward,
            },
        );

        // Kitchen Deploy MasterChef
        expect(masterChefResult.transactions).toHaveTransaction({
            from: kitchen.address,
            to: masterChef.address,
            success: true,
        });

        // MasterChef should send remaining TON to Owner
        expect(masterChefResult.transactions).toHaveTransaction({
            from: masterChef.address,
            to: deployer.address,
            success: true,
        });

        // isInitialized should be true
        const isInitialized = (await masterChef.getGetTonMasterChefData()).isInitialized;
        expect(isInitialized).toBe(true);

        rewardPerSecond = await (await masterChef.getGetTonMasterChefData()).rewardPerSecond;
    });

    it('Should owner add pool into MasterChef', async () => {
        const allocPoint = 100n;
        const addPoolResult = await addPool(masterChef, masterChefJettonWallet, allocPoint);
        // Send AddPool to MasterChef
        expect(addPoolResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: masterChef.address,
            success: true,
        });

        let poolData: PoolInfo = await masterChef.getGetPoolInfo(masterChefJettonWallet.address);
        // allocPoint should be equal to 100
        expect(poolData.allocPoint).toBe(allocPoint);

        // poolData.lpToken should be equal to masterChefJettonWallet.address
        expect(poolData.lpTokenAddress.toString()).toBe(masterChefJettonWallet.address.toString());
    });

    it('Should revert if owner add pool and its total allocate point exceeds 10000', async () => {
        const allocPoint = 10001n;
        const addPoolResult = await addPool(masterChef, masterChefJettonWallet, allocPoint);
        // Send AddPool to MasterChef
        expect(addPoolResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: masterChef.address,
            success: false,
            exitCode: 25081, // total alloc point exceeds 10000
        });
    });

    it('Should user deposit usdt to master chef and update pool', async () => {
        await addPool(masterChef, masterChefJettonWallet);
        const userDepositAmount = 1n * 10n ** 6n;
        const periodTime = 10;
        const depositResult = await deposit(masterChef, user, masterChefJettonWallet, usdt, userDepositAmount);
        // send the deposit to MasterChef
        expect(depositResult.transactions).toHaveTransaction({
            from: masterChefJettonWallet.address,
            to: masterChef.address,
            success: true,
        });

        let miniChefAddress = await masterChef.getGetMiniChefAddress(user.address);
        // check if masterchef send userDeposit to minichef
        expect(depositResult.transactions).toHaveTransaction({
            from: masterChef.address,
            to: miniChefAddress,
            success: true,
        });
        let miniChef = blockchain.openContract(await MiniChef.fromAddress(miniChefAddress));
        const userInfo = await miniChef.getGetUserInfo(masterChefJettonWallet.address);
        // check the user deposit amount is correct
        expect(userInfo.amount).toBe(userDepositAmount);
        // check the reqardDeft is zero
        expect(userInfo.rewardDebt).toBe(0n);

        const poolDataBefore: PoolInfo = await masterChef.getGetPoolInfo(masterChefJettonWallet.address);
        blockchain.now!! += periodTime;
        // user send update Pool to masterchef
        const updatePoolResult = await masterChef.send(
            user.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'UpdatePool',
                lpTokenAddress: masterChefJettonWallet.address,
            },
        );
        // check user send update Pool to masterchef is updated
        expect(updatePoolResult.transactions).toHaveTransaction({
            from: user.address,
            to: masterChef.address,
            success: true,
        });
        const poolDataAfter: PoolInfo = await masterChef.getGetPoolInfo(masterChefJettonWallet.address);
        // check the accRewardPerShare is updated
        expect(poolDataAfter.accRewardPerShare).toEqual(
            poolDataBefore.accRewardPerShare + BigInt(periodTime) * rewardPerSecond,
        );
    });

    it('Should deposit and harvest', async () => {
        await addPool(masterChef, masterChefJettonWallet);
        const userDepositAmount = 1n * 10n ** 6n;
        const periodTime = 1000;
        await depositJetton(usdt, user, masterChef, userDepositAmount);
        // Update time to periodTime, so that we can harvest
        blockchain.now!! += periodTime;
        const userTonBalanceBefore = await user.getBalance();
        // User send Harvest to MasterChef
        const harvestResult = await harvest(masterChef, user, masterChefJettonWallet);
        const userTonBalanceAfter = await user.getBalance();

        // Check if the user send Harvest to MasterChef
        expect(harvestResult.transactions).toHaveTransaction({
            from: user.address,
            to: masterChef.address,
            success: true,
        });

        // Check if the MasterChef send HarvestInternal to MiniChef
        let miniChefAddress = await masterChef.getGetMiniChefAddress(user.address);
        expect(harvestResult.transactions).toHaveTransaction({
            from: masterChef.address,
            to: miniChefAddress,
            success: true,
        });

        // Check if MiniChef send HarvestInternalReply to user
        expect(harvestResult.transactions).toHaveTransaction({
            from: miniChefAddress,
            to: masterChef.address,
            success: true,
        });

        // Check that MasterChef send TON to user
        expect(harvestResult.transactions).toHaveTransaction({
            from: masterChef.address,
            to: user.address,
            success: true,
        });

        const benefit = (userDepositAmount * BigInt(periodTime) * rewardPerSecond) / 10n ** 6n;
        // Check if user get the reward
        expect(userTonBalanceAfter - userTonBalanceBefore).toBeGreaterThanOrEqual(benefit - fee);
    });

    it('Should deposit and harvest twice', async () => {
        await addPool(masterChef, masterChefJettonWallet);
        const userDepositAmount = 1n * 10n ** 6n;
        const periodTime = 1000;
        await depositJetton(usdt, user, masterChef, userDepositAmount);
        // Update time to periodTime, so that we can harvest
        blockchain.now!! += periodTime;
        const userJettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(user.address, usdt.address));
        const userTonBalanceBefore = await user.getBalance();
        // User send Harvest to MasterChef
        await harvest(masterChef, user, masterChefJettonWallet);

        // User JettonWallet should have received the reward
        const userTonBalanceAfter = await user.getBalance();
        const benefit = (userDepositAmount * BigInt(periodTime) * rewardPerSecond) / 10n ** 6n;
        expect(userTonBalanceAfter).toBeGreaterThanOrEqual(userTonBalanceBefore + benefit - fee);

        // User Deposit Again
        await userJettonWallet.send(
            user.getSender(),
            { value: toNano('1.1') },
            {
                $$type: 'JettonTransfer',
                query_id: 0n,
                amount: userDepositAmount,
                destination: masterChef.address,
                response_destination: user.address,
                custom_payload: null,
                forward_ton_amount: toNano('1'),
                forward_payload: beginCell().endCell(),
            },
        );
        // Update time to periodTime, so that we can harvest
        blockchain.now!! += periodTime;
        const userTonBalanceBefore2rdHarvest = await user.getBalance();
        // User send Harvest to MasterChef
        await harvest(masterChef, user, masterChefJettonWallet);

        // User JettonWallet should have received the reward
        // It shoud add deposit amount to the previous balance, so that we can calculate the benefit from the second harvest
        const userTonBalanceAfter2rdHarvest = await user.getBalance();
        // check the benefit of user1 and user2 are correct
        const benefit1 = BigInt(periodTime) * rewardPerSecond;
        expect(userTonBalanceAfter2rdHarvest).toBeGreaterThanOrEqual(userTonBalanceBefore2rdHarvest + benefit1 - fee);
    });

    it('Should Harvest After Deadline', async () => {
        await addPool(masterChef, masterChefJettonWallet);
        const userDepositAmount = 1n * 10n ** 6n;
        const periodTime = 1000;
        await depositJetton(usdt, user, masterChef, userDepositAmount);
        // Update time to periodTime, so that we can harvest
        blockchain.now!! += periodTime;
        const userJettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(user.address, usdt.address));
        const userTonBalanceBefore = await user.getBalance();
        // User send Harvest to MasterChef
        await harvest(masterChef, user, masterChefJettonWallet);

        // User JettonWallet should have received the reward
        const userTonBalanceAfter = await user.getBalance();
        const benefit = (userDepositAmount * BigInt(periodTime) * rewardPerSecond) / 10n ** 6n;
        expect(userTonBalanceAfter).toBeGreaterThanOrEqual(userTonBalanceBefore + benefit - fee);

        // User Deposit Again
        await userJettonWallet.send(
            user.getSender(),
            { value: toNano('1.1') },
            {
                $$type: 'JettonTransfer',
                query_id: 0n,
                amount: userDepositAmount,
                destination: masterChef.address,
                response_destination: user.address,
                custom_payload: null,
                forward_ton_amount: toNano('1'),
                forward_payload: beginCell().endCell(),
            },
        );
        // Update time to periodTime, so that we can harvest
        blockchain.now!! += periodTime * 3;
        const userTonBalanceBefore2rdHarvest = await user.getBalance();

        // User send Harvest to MasterChef
        await harvest(masterChef, user, masterChefJettonWallet);

        // User JettonWallet should have received the reward
        // It shoud add deposit amount to the previous balance, so that we can calculate the benefit from the second harvest
        const userTonBalanceAfter2rdHarvest = await user.getBalance();
        // check the benefit of user1 and user2 are correct
        // Only get the benefit until the deadline
        const benefit1 = BigInt(periodTime) * rewardPerSecond;
        expect(userTonBalanceAfter2rdHarvest).toBeGreaterThanOrEqual(userTonBalanceBefore2rdHarvest + benefit1 - fee);
    });

    it('Should deposit and withdraw', async () => {
        const userDepositAmount = 1n * 10n ** 6n;
        const userWithdrawAmount = 5n * 10n ** 5n;
        const periodTime = 10;
        const userJettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(user.address, usdt.address));
        // deposit first
        await deposit(masterChef, user, masterChefJettonWallet, usdt, userDepositAmount);
        // get the balance of usdt before withdraw
        const userUSDTBalanceBefore = (await userJettonWallet.getGetWalletData()).balance;

        // withdraw
        blockchain.now!! += periodTime;
        const withdrawResult = await withdraw(masterChef, user, masterChefJettonWallet, userWithdrawAmount);
        // check the depositAndWithdrawResult is sucess
        expect(withdrawResult.transactions).toHaveTransaction({
            from: user.address,
            to: masterChef.address,
            success: true,
            op: 0x097bb407,
        });

        const userUSDTBalanceAfter = (await userJettonWallet.getGetWalletData()).balance;

        // check the differnce between userUSDTBalanceBefore and userUSDTBalanceAfter is equal to userWithdrawAmount
        expect(userUSDTBalanceAfter).toEqual(userUSDTBalanceBefore + userWithdrawAmount);
    });

    it('Should deposit and withdarw with harvest', async () => {
        const userDepositAmount = 1n * 10n ** 6n;
        const userWithdrawAmount = 5n * 10n ** 5n;
        const periodTime = 100;
        const userJettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(user.address, usdt.address));
        // deposit first
        await deposit(masterChef, user, masterChefJettonWallet, usdt, userDepositAmount);
        // get the balance of ton before withdraw
        const userTonBalanceBefore = await user.getBalance();

        // Update time to periodTime, so that we can withdraw
        blockchain.now!! += periodTime;
        // withdraw
        await withdraw(masterChef, user, masterChefJettonWallet, userWithdrawAmount);
        const userTonBalanceBeforeHarvest = await user.getBalance();

        // Update time to periodTime, so that we can harvest
        blockchain.now!! += periodTime;
        // User send Harvest to MasterChef
        await harvest(masterChef, user, masterChefJettonWallet);
        const userTonBalanceAfterHarvest = await user.getBalance();
        // check the differnce between userUSDTBalanceBeforeWithdraw and userUSDTBalanceAfterHarvest is equal to userWithdrawAmount
        //expect(userUSDTBalanceBeforeHarvest).toEqual(userUSDTBalanceBeforeWithdraw + userWithdrawAmount);
        // check the differnce between userUSDTBalanceBeforeWithdraw and userUSDTBalanceAfterHarvest is equal to userWithdrawAmount
        const remainDeposit = userDepositAmount - userWithdrawAmount;
        const benefit = ((userDepositAmount + remainDeposit) * BigInt(periodTime) * rewardPerSecond) / 10n ** 6n;

        expect(userTonBalanceAfterHarvest).toBeGreaterThanOrEqual(userTonBalanceBeforeHarvest + benefit - fee);
    });

    it('Should not withdraw internal reply by user', async () => {
        const userDepositAmount = 1n * 10n ** 6n;
        const userWithdrawAmount = 5n * 10n ** 5n;
        // deposit first
        await deposit(masterChef, user, masterChefJettonWallet, usdt, userDepositAmount);

        const withdrawInternalReplyResult = await masterChef.send(
            user.getSender(),
            { value: toNano('1') },
            {
                $$type: 'WithdrawInternalReply',
                queryId: 0n,
                lpTokenAddress: masterChefJettonWallet.address,
                amount: userWithdrawAmount,
                sender: user.address,
                beneficiary: user.address,
            },
        );
        // check the withdrawInternalReplyResult is not sucess
        expect(withdrawInternalReplyResult.transactions).toHaveTransaction({
            from: user.address,
            to: masterChef.address,
            success: false,
            op: 0xdc4c8b1a,
            exitCode: 33311, //unexpected sender
        });
    });

    it('should not harvest internal reply by user', async () => {
        // deposit first
        await deposit(masterChef, user, masterChefJettonWallet, usdt);

        const harvestInternalReplyResult = await masterChef.send(
            user.getSender(),
            { value: toNano('1') },
            {
                $$type: 'HarvestInternalReply',
                queryId: 0n,
                lpTokenAddress: masterChefJettonWallet.address,
                beneficiary: user.address,
                reward: 100000n,
                sender: user.address,
            },
        );

        // check the harvestInternalReplyResult is not sucess
        expect(harvestInternalReplyResult.transactions).toHaveTransaction({
            from: user.address,
            to: masterChef.address,
            success: false,
            op: 0x952bcd19,
            exitCode: 33311, //unexpected sender
        });
    });

    it('should harvest by different user', async () => {
        const user1 = await blockchain.treasury('user1');
        const user2 = await blockchain.treasury('user2');
        const user1DepositAmount = 1n * 10n ** 6n;
        const user2DepositAmount = 2n * 10n ** 6n;
        const periodTime = 100;
        // addpool
        await addPool(masterChef, masterChefJettonWallet);
        // user1 deposit
        await depositJetton(usdt, user1, masterChef, user1DepositAmount);
        // const user1JettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(user1.address, usdt.address));
        // const user1USDTBalanceBefore = (await user1JettonWallet.getGetWalletData()).balance;
        const user1TonBalanceBefore = await user1.getBalance();
        // user2 deposit
        await depositJetton(usdt, user2, masterChef, user2DepositAmount);
        // const user2JettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(user2.address, usdt.address));
        // const user2USDTBalanceBefore = (await user2JettonWallet.getGetWalletData()).balance;
        const user2TonBalanceBefore = await user2.getBalance();
        blockchain.now!! += periodTime;
        // user1 harvest
        await harvest(masterChef, user1, masterChefJettonWallet);
        // const user1USDTBalanceAfter = (await user1JettonWallet.getGetWalletData()).balance;
        const user1TonBalanceAfter = await user1.getBalance();
        // user2 harvest
        await harvest(masterChef, user2, masterChefJettonWallet);
        // const user2USDTBalanceAfter = (await user2JettonWallet.getGetWalletData()).balance;
        const user2TonBalanceAfter = await user2.getBalance();

        // check the benefit of user1 and user2 are correct
        const totalDeposit = user1DepositAmount + user2DepositAmount;
        const rewardPerShare = (10n ** 6n * (BigInt(periodTime) * rewardPerSecond)) / totalDeposit;
        const benefit1 = (user1DepositAmount * rewardPerShare) / 10n ** 6n;
        const benefit2 = (user2DepositAmount * rewardPerShare) / 10n ** 6n;

        expect(user1TonBalanceAfter).toBeGreaterThanOrEqual(user1TonBalanceBefore + benefit1 - fee);
        expect(user2TonBalanceAfter).toBeGreaterThanOrEqual(user2TonBalanceBefore + benefit2 - fee);
    });

    it('should ThunderMint can collect the Fees from projcet party and users', async () => {
        const userDepositAmount = 1n * 10n ** 6n;
        const userWithdrawAmount = 5n * 10n ** 5n;
        const periodTime = 10;
        const rewardTONForDev = 30000000n;
        // deposit first
        await deposit(masterChef, user, masterChefJettonWallet, usdt, userDepositAmount);

        // withdraw
        blockchain.now!! += periodTime;
        const withdrawResult = await withdraw(masterChef, user, masterChefJettonWallet, userWithdrawAmount);
        // check the depositAndWithdrawResult is sucess
        expect(withdrawResult.transactions).toHaveTransaction({
            from: user.address,
            to: masterChef.address,
            success: true,
            op: 0x097bb407,
        });
        const masterChefDataAfterWithdraw = await masterChef.getGetTonMasterChefData();
        // Make sure that tonForDevs is recorded after user withdraw
        expect(masterChefDataAfterWithdraw.tonForDevs).toEqual(10000000n + rewardTONForDev); // Withdraw's fee is 0.1 TON, and REWARD_FEE = 0.3 TON (0.3% of the reward)

        // Update time to periodTime, so that we can harvest
        blockchain.now!! += periodTime;
        // User send Harvest to MasterChef
        await harvest(masterChef, user, masterChefJettonWallet);
        const masterChefDataAfterHarvest = await masterChef.getGetTonMasterChefData();
        expect(masterChefDataAfterHarvest.tonForDevs).toEqual(20000000n + rewardTONForDev); // Harvest's fee is 0.1 TON and add Withdraw's fee = 0.2 TON

        // Send Collect Msg to MasterChef
        let thunderMintTonBefore = await thunderMint.getBalance();
        //let thunderJettonBefore = (await thunderMintJettonWallet.getGetWalletData()).balance;
        let count = 5n;
        // Increase fees for devs
        for (let i = 0; i < count; i++) {
            await deposit(masterChef, user, masterChefJettonWallet, usdt, userDepositAmount);
            // withdraw
            blockchain.now!! += periodTime;
            await withdraw(masterChef, user, masterChefJettonWallet, userWithdrawAmount);
        }
        const masterChefData = await masterChef.getGetTonMasterChefData();
        const collectResult = await masterChef.send(deployer.getSender(), { value: toNano('1') }, 'CollectTON');
        let thunderMintTonAfter = await thunderMint.getBalance();

        // Check if deployer send Collect msg to MasterChef
        expect(collectResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: masterChef.address,
            success: true,
        });
        // Check if MasterChef send JettonTransfer to MasterChef Reward JettonWallet
        expect(collectResult.transactions).toHaveTransaction({
            from: masterChef.address,
            to: thunderMint.address,
            success: true,
        });

        let diffTON = thunderMintTonAfter - thunderMintTonBefore;
        // Check if the MasterChef send TON to ThunderMint
        expect(diffTON).toBeGreaterThan(0);
        // Check if the MasterChef send TON for Devs to ThunderMint
        expect(thunderMintTonAfter).toBeGreaterThanOrEqual(masterChefData.tonForDevs + rewardTONForDev);
    });

    it('should not initialize if not enough reward', async () => {
        let blockchain: Blockchain;
        let deployer: SandboxContract<TreasuryContract>;
        let user: SandboxContract<TreasuryContract>;
        let masterChef: SandboxContract<TonMasterChef>;
        let usdt: SandboxContract<JettonMasterUSDT>;
        let masterChefJettonWallet: SandboxContract<JettonWalletUSDT>;
        let deployerJettonWallet: SandboxContract<JettonWalletUSDT>;

        // Init the blockchain
        blockchain = await Blockchain.create();
        blockchain.now = Math.floor(Date.now() / 1000);

        // Characters
        deployer = await blockchain.treasury('deployer'); // Owner of MasterChef
        user = await blockchain.treasury('user'); // User who deposits, withdraws, and harvests
        thunderMint = await blockchain.treasury('thunderMint'); // Dev team who receives the fees

        // Contracts
        kitchen = await blockchain.openContract(await Kitchen.fromInit(deployer.address, 0n)); // MasterChef Factory
        usdt = blockchain.openContract(await JettonMasterUSDT.fromInit(deployer.address, beginCell().endCell())); // Reward token and LP token
        seed = BigInt(`0x${beginCell().storeUint(Date.now(), 64).endCell().hash().toString('hex')}`); // Seed for MasterChef

        deployerJettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(deployer.address, usdt.address)); // Deployer USDT JettonWallet
        thunderMintJettonWallet = blockchain.openContract(
            await JettonWalletUSDT.fromInit(thunderMint.address, usdt.address),
        ); // ThunderMint USDT JettonWallet

        // Setup all the contracts
        await usdt.send(deployer.getSender(), { value: toNano('1') }, 'Mint:1'); // Mint USDT to deployer so that he can start the MasterChef
        const kitcherResult = await kitchen.send(
            deployer.getSender(),
            {
                value: toNano('0.5'),
            },
            {
                $$type: 'Deploy',
                queryId: 0n,
            },
        );

        expect(kitcherResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: kitchen.address,
            deploy: true,
            success: true,
        });

        let masterChefAddress = await kitchen.getGetTonMasterChefAddress(deployer.address, seed); // MasterChef address
        masterChef = blockchain.openContract(await TonMasterChef.fromAddress(masterChefAddress)); // MasterChef
        masterChefJettonWalletAddress = await usdt.getGetWalletAddress(masterChefAddress); // MasterChef USDT JettonWallet address
        masterChefJettonWallet = blockchain.openContract(
            await JettonWalletUSDT.fromAddress(masterChefJettonWalletAddress),
        ); // MasterChef USDT JettonWallet

        deadline = BigInt(blockchain.now!! + 2000);
        totalReward = toNano('10');
        let sendingTon = (totalReward * 1003n) / 1000n + toNano('1');
        // Build the MasterChef contract from kitchen
        const masterChefResult = await kitchen.send(
            deployer.getSender(),
            {
                value: sendingTon - toNano('10'),
            },
            {
                $$type: 'BuildTonMasterChef',
                owner: deployer.address,
                seed: seed,
                thunderMintWallet: thunderMint.address,
                metaData: beginCell().storeStringTail('httpppp').endCell(),
                deadline: deadline,
                totalReward: totalReward,
            },
        );

        // Kitchen Deploy MasterChef
        expect(masterChefResult.transactions).toHaveTransaction({
            from: kitchen.address,
            to: masterChef.address,
            success: false,
            exitCode: 31992, // not enough reward
        });

        // isInitialized should be true
        const isInitialized = (await masterChef.getGetTonMasterChefData()).isInitialized;
        expect(isInitialized).toBe(false);
    });

    it('Should deposit, withdraw and harvest after deadline', async () => {
        const userDepositAmount = 1n * 10n ** 6n;
        const userWithdrawAmount = 5n * 10n ** 5n;
        const periodTime = 3500; // deadline is 2000
        const userJettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(user.address, usdt.address));

        // Update time to periodTime to make sure that the deadline is passed
        blockchain.now!! += periodTime;
        // deposit first
        await deposit(masterChef, user, masterChefJettonWallet, usdt, userDepositAmount);
        // get the balance of usdt before withdraw
        const userUSDTBalanceBeforeWithdraw = (await userJettonWallet.getGetWalletData()).balance;

        // withdraw
        await withdraw(masterChef, user, masterChefJettonWallet, userWithdrawAmount);
        const userUSDTBalanceAfterWithdraw = (await userJettonWallet.getGetWalletData()).balance;
        // check the differnce between userUSDTBalanceBeforeWithdraw and userUSDTBalanceAfterWithdraw is equal to userWithdrawAmount
        expect(userUSDTBalanceAfterWithdraw - userUSDTBalanceBeforeWithdraw).toEqual(userWithdrawAmount);

        // Update time to periodTime, so that we can harvest
        blockchain.now!! += periodTime;
        const userTonBalanceBeforeHarvest = await user.getBalance();
        // User send Harvest to MasterChef
        await harvest(masterChef, user, masterChefJettonWallet);
        const userTonBalanceAfterHarvest = await user.getBalance();
        // After Harvest, the user should have the less balance as before harvest (It should not add any reward, because the deadline is passed and he paid the fee for the harvest, so it will be less than before harvest)
        expect(userTonBalanceAfterHarvest).toBeLessThanOrEqual(userTonBalanceBeforeHarvest);
    });

    it('Should deposit and harvest but deadline passed in the midle', async () => {
        const userDepositAmount = 1n * 10n ** 6n;
        const periodTime = 2500;
        const userJettonWallet = blockchain.openContract(await JettonWalletUSDT.fromInit(user.address, usdt.address));
        // deposit first
        await deposit(masterChef, user, masterChefJettonWallet, usdt, userDepositAmount);
        // get the balance of usdt before withdraw

        const startBlock = BigInt(blockchain.now!!);
        // Update time to periodTime, so that we can harvest
        blockchain.now!! += periodTime;
        const userTonBalanceBeforeHarvest = await user.getBalance();
        // User send Harvest to MasterChef
        await harvest(masterChef, user, masterChefJettonWallet);
        const userTonBalanceAfterHarvest = await user.getBalance();
        // It can only get the benefit until the deadline
        const benefit = (userDepositAmount * BigInt(deadline - startBlock) * rewardPerSecond) / 10n ** 6n;
        expect(userTonBalanceAfterHarvest).toBeLessThanOrEqual(userTonBalanceBeforeHarvest + benefit);
    });
});

import { toNano, Address, beginCell } from '@ton/core';
import { Kitchen } from '../wrappers/Kitchen';
import { NetworkProvider } from '@ton/blueprint';
import { loadDeployment, updateDeployment } from '../utils/helper';
import { JettonMinter } from '../wrappers/JettonMinter';
import { JettonWallet } from '../wrappers/RealJettonWallet';

export async function run(provider: NetworkProvider) {
    const deployment = await loadDeployment();
    const kitchen = provider.open(Kitchen.fromAddress(Address.parse(deployment.Kitchen)));
    const rewardTokenMasterAddress = Address.parse("EQB3Xa6oQ4TVwXtDCYUq6DuDgWuZ6Lc-J2yaS5dirMMHyQpl")
    const rewardTokenMaster = provider.open(JettonMinter.createFromAddress(rewardTokenMasterAddress));
    const senderUSDTWalletAddress = await rewardTokenMaster.getWalletAddress(provider.sender().address!!);
    console.log('senderUSDTWalletAddress', senderUSDTWalletAddress);
    const senderUSDTWallet = provider.open(JettonWallet.createFromAddress(senderUSDTWalletAddress));
    console.log('senderUSDTWallet', (await senderUSDTWallet.getJettonBalance()).toString());
    const seed = BigInt(`0x${beginCell().storeUint(Date.now(), 64).endCell().hash().toString('hex')}`);
    const masterchefAddress = await kitchen.getGetJettonMasterChefAddress(provider.sender().address!!, seed);
    const mcUSDTWalletAddress = await rewardTokenMaster.getWalletAddress(masterchefAddress);
    const masterchefUSDTWallet = provider.open(await JettonWallet.createFromAddress(mcUSDTWalletAddress));
    const totalReward = 50n * 10n ** 6n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);

    await kitchen.send(
        provider.sender(),
        {
            value: toNano('0.5'),
        },
        {
            $$type: 'BuildJettonMasterChef',
            owner: provider.sender().address!!,
            seed: seed,
            thunderMintJettonWallet: senderUSDTWallet.address, // owner jettonWallet
            mcRewardJettonWallet: masterchefUSDTWallet.address,
            metaData: beginCell().storeStringTail('httpppp').endCell(),
            deadline: deadline,
            startTime: BigInt(Math.floor(Date.now() / 1000)) + 10n,
            totalReward: totalReward,
        },
    );
    await provider.waitForDeploy(masterchefAddress);
    if (!(await provider.isContractDeployed(masterchefAddress))) {
        return;
    }
    await updateDeployment('MasterChef', masterchefAddress.toString());
}